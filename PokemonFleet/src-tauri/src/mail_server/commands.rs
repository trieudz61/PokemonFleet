//! Tauri commands for the Mail Server tab UI.

use std::sync::Arc;
use tauri::{State, Manager};
use tracing::info;

use super::{MailServerState, config::MailConfig};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Get current mail server status.
#[tauri::command]
pub async fn mail_server_status(
    state: State<'_, Arc<MailServerState>>,
) -> CmdResult<serde_json::Value> {
    let config = state.config.read();
    Ok(serde_json::json!({
        "running": *state.running.read(),
        "imap_connected": *state.imap_connected.read(),
        "imap_user": config.as_ref().map(|c| c.imap_user.as_str()).unwrap_or(""),
        "total_emails_cached": state.emails.read().len(),
        "public_url": *state.public_url.read(),
        "last_check": *state.last_check.read(),
    }))
}

/// Save mail server config.
#[tauri::command]
pub async fn mail_server_save_config(
    state: State<'_, Arc<MailServerState>>,
    app: tauri::AppHandle,
    config: MailConfig,
) -> CmdResult<()> {
    // Save to file
    let data_dir = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&data_dir).ok();
    let config_path = data_dir.join("mail_config.json");
    config.save(&config_path).map_err(err)?;

    // Update state
    *state.config.write() = Some(config);
    info!("Mail server config saved");
    Ok(())
}

/// Load mail server config.
#[tauri::command]
pub async fn mail_server_load_config(
    state: State<'_, Arc<MailServerState>>,
    app: tauri::AppHandle,
) -> CmdResult<Option<MailConfig>> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let config_path = data_dir.join("mail_config.json");

    if let Some(config) = MailConfig::load(&config_path) {
        *state.config.write() = Some(config.clone());
        Ok(Some(config))
    } else {
        Ok(None)
    }
}

/// Start the mail server (IMAP poller + HTTP API + ngrok tunnel).
#[tauri::command]
pub async fn mail_server_start(
    state: State<'_, Arc<MailServerState>>,
) -> CmdResult<String> {
    // Check if already running
    if *state.running.read() {
        return Ok("already_running".to_string());
    }

    let config = state.config.read().clone()
        .ok_or_else(|| "Config not set — save config first".to_string())?;

    if config.imap_user.is_empty() || config.imap_pass.is_empty() {
        return Err("iCloud email and password are required".to_string());
    }

    let port = config.server_port;
    let state_arc: Arc<MailServerState> = Arc::clone(&state);

    // Start IMAP poller
    let poller_state = Arc::clone(&state_arc);
    let poller_config = config.clone();
    let poller_handle = tokio::spawn(async move {
        super::imap_poller::run(poller_state, poller_config).await;
    });

    // Start HTTP server
    let http_state = Arc::clone(&state_arc);
    let http_handle = tokio::spawn(async move {
        super::http_api::run(http_state, port).await;
    });

    // Start ngrok tunnel if domain is configured
    let url = if let Some(ref domain) = config.ngrok_domain {
        if !domain.is_empty() {
            info!("Starting ngrok tunnel: {} -> localhost:{}", domain, port);
            let mut cmd = std::process::Command::new("ngrok");
            cmd.arg("http")
                .arg(format!("{}", port))
                .arg("--url")
                .arg(domain);

            // Add authtoken if provided
            if let Some(ref token) = config.ngrok_token {
                if !token.is_empty() {
                    cmd.arg("--authtoken").arg(token);
                }
            }

            // Suppress ngrok output
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());

            match cmd.spawn() {
                Ok(child) => {
                    let pid = child.id();
                    *state.ngrok_pid.write() = Some(pid);
                    info!("ngrok process spawned PID={} for {}", pid, domain);
                }
                Err(e) => {
                    tracing::warn!("Failed to start ngrok: {}. Is ngrok installed?", e);
                }
            }
            format!("https://{}", domain)
        } else {
            format!("http://localhost:{}", port)
        }
    } else {
        format!("http://localhost:{}", port)
    };

    *state.running.write() = true;
    *state.poller_handle.write() = Some(poller_handle);
    *state.http_handle.write() = Some(http_handle);
    *state.public_url.write() = Some(url.clone());

    info!("Mail server started on {}", url);
    Ok(url)
}

/// Stop the mail server.
#[tauri::command]
pub async fn mail_server_stop(
    state: State<'_, Arc<MailServerState>>,
) -> CmdResult<()> {
    if !*state.running.read() {
        return Ok(());
    }

    // Abort tasks
    if let Some(handle) = state.poller_handle.write().take() {
        handle.abort();
    }
    if let Some(handle) = state.http_handle.write().take() {
        handle.abort();
    }

    // Kill ngrok process by PID
    if let Some(pid) = state.ngrok_pid.write().take() {
        info!("Killing ngrok process PID={}", pid);
        super::kill_process(pid);
    }

    *state.running.write() = false;
    *state.imap_connected.write() = false;
    *state.public_url.write() = None;

    info!("Mail server stopped");
    Ok(())
}
