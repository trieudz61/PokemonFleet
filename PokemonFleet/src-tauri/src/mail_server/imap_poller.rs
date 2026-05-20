//! IMAP poller — connects to iCloud IMAP and polls for new emails.

use std::sync::Arc;
use async_native_tls::TlsConnector;
use mail_parser::MessageParser;
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tracing::{info, warn};

use super::{CachedEmail, MailServerState};
use super::config::MailConfig;

/// Run the IMAP polling loop. This function runs forever until the task is aborted.
pub async fn run(state: Arc<MailServerState>, config: MailConfig) {
    info!("IMAP poller starting for {}", config.imap_user);

    loop {
        match poll_once(&state, &config).await {
            Ok(count) => {
                if count > 0 {
                    info!("Fetched {} new emails", count);
                }
                *state.imap_connected.write() = true;
                *state.last_check.write() = Some(chrono::Utc::now().to_rfc3339());
            }
            Err(e) => {
                warn!("IMAP poll error: {}", e);
                *state.imap_connected.write() = false;
            }
        }
        // Poll every 5 seconds
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

async fn poll_once(state: &Arc<MailServerState>, config: &MailConfig) -> anyhow::Result<usize> {
    // Connect with compat layer (async-imap needs futures AsyncRead/Write)
    let tcp = TcpStream::connect((config.imap_host.as_str(), config.imap_port)).await?;
    let tcp_compat = tcp.compat();
    let tls = TlsConnector::new();
    let tls_stream = tls.connect(&config.imap_host, tcp_compat).await?;

    let client = async_imap::Client::new(tls_stream);
    let mut session = client
        .login(&config.imap_user, &config.imap_pass)
        .await
        .map_err(|e| anyhow::anyhow!("IMAP login failed: {:?}", e.0))?;

    // Select INBOX
    let mailbox = session.select("INBOX").await?;

    // Fetch recent unseen messages
    let existing_ids: Vec<String> = state.emails.read().iter().map(|e| e.id.clone()).collect();

    // Fetch the most recent 50 emails (newest first)
    let total = mailbox.exists as u32;
    let fetch_range = if total > 50 {
        format!("{}:*", total - 49)
    } else {
        "1:*".to_string()
    };
    let messages = session.fetch(&fetch_range, "(UID ENVELOPE BODY.PEEK[])").await?;

    // Collect into vec to release borrow on session
    use futures::StreamExt;
    let fetched: Vec<_> = messages.collect::<Vec<_>>().await;

    session.logout().await.ok();

    // Now process collected messages
    let parser = MessageParser::default();
    let mut new_count = 0;

    for msg_result in fetched {
        let msg = match msg_result {
            Ok(m) => m,
            Err(_) => continue,
        };

        let body_raw = match msg.body() {
            Some(b) => b,
            None => continue,
        };

        let parsed = match parser.parse(body_raw) {
            Some(p) => p,
            None => continue,
        };

        // Generate stable ID from UID
        let uid = msg.uid.unwrap_or(0);
        let id = format!("{:08x}", uid);

        // Skip if already cached
        if existing_ids.contains(&id) {
            continue;
        }

        // Extract fields
        let to_addrs: Vec<String> = parsed
            .to()
            .map(|list| {
                list.as_list()
                    .map(|addrs| addrs.iter().filter_map(|a| a.address().map(|s| s.to_string())).collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        let from_addr = parsed
            .from()
            .and_then(|f| f.as_list())
            .and_then(|list| list.first())
            .and_then(|a| a.address())
            .unwrap_or("")
            .to_string();

        let subject = parsed.subject().unwrap_or("").to_string();
        let date = parsed.date()
            .map(|d| d.to_rfc3339())
            .unwrap_or_default();

        let body_text = parsed.body_text(0).unwrap_or_default().to_string();
        let body_html = parsed.body_html(0).unwrap_or_default().to_string();

        let hide_my_email = to_addrs.first().cloned().unwrap_or_default();

        let email = CachedEmail {
            id,
            to: to_addrs,
            hide_my_email,
            from: from_addr,
            subject,
            date,
            received_at: chrono::Utc::now().to_rfc3339(),
            body_text,
            body_html,
        };

        let mut emails = state.emails.write();
        emails.insert(0, email);
        // Trim to max
        let max = state.config.read().as_ref().map(|c| c.max_emails).unwrap_or(500);
        if emails.len() > max {
            emails.truncate(max);
        }
        new_count += 1;
    }

    Ok(new_count)
}
