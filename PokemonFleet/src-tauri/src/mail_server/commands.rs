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
    app: tauri::AppHandle,
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

    // Wait for HTTP server to be ready before starting ngrok
    {
        let addr = format!("127.0.0.1:{}", port);
        info!("Waiting for HTTP server to bind on {}...", addr);
        let mut ready = false;
        for i in 0..50 {
            // Try to connect to the port
            if std::net::TcpStream::connect(&addr).is_ok() {
                info!("HTTP server is ready on {} (after {}ms)", addr, i * 100);
                ready = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if !ready {
            tracing::warn!("HTTP server did not become ready within 5s on {}", addr);
        }
    }

    // Start ngrok tunnel if domain is configured
    let mut ngrok_error = None;
    let url = if let Some(ref domain) = config.ngrok_domain {
        if !domain.is_empty() {
            info!("Starting bundled ngrok sidecar: {} -> 127.0.0.1:{}", domain, port);
            
            use tauri_plugin_shell::ShellExt;

            let mut args = vec![
                "http".to_string(), 
                format!("127.0.0.1:{}", port),
                "--url".to_string(),
                domain.clone(),
                "--log".to_string(),
                "stdout".to_string()
            ];

            // Add authtoken if provided
            if let Some(ref token) = config.ngrok_token {
                if !token.is_empty() {
                    args.push("--authtoken".to_string());
                    args.push(token.clone());
                }
            }

            info!("Attempting to spawn ngrok sidecar with args: {:?}", args);

            match app.shell().sidecar("ngrok") {
                Ok(sidecar) => {
                    match sidecar.args(args).spawn() {
                        Ok((mut rx, child)) => {
                            let pid = child.pid();
                            *state.ngrok_pid.write() = Some(pid);
                            info!("ngrok sidecar successfully spawned PID={}", pid);
                            
                            // Pipe ngrok output to terminal for debugging
                            tokio::spawn(async move {
                                use tauri_plugin_shell::process::CommandEvent;
                                while let Some(event) = rx.recv().await {
                                    match event {
                                        CommandEvent::Stdout(line) => {
                                            info!("[ngrok] {}", String::from_utf8_lossy(&line).trim());
                                        }
                                        CommandEvent::Stderr(line) => {
                                            tracing::warn!("[ngrok-err] {}", String::from_utf8_lossy(&line).trim());
                                        }
                                        CommandEvent::Terminated(payload) => {
                                            tracing::error!("[ngrok-exit] Code: {:?}", payload.code);
                                        }
                                        _ => {}
                                    }
                                }
                            });

                            format!("https://{}", domain)
                        }
                        Err(e) => {
                            let msg = format!("Failed to spawn ngrok sidecar: {}", e);
                            tracing::error!("{}", msg);
                            ngrok_error = Some(msg);
                            format!("http://127.0.0.1:{}", port)
                        }
                    }
                }
                Err(e) => {
                    let msg = format!("Failed to locate ngrok sidecar binary: {}. Using localhost only.", e);
                    tracing::warn!("{}", msg);
                    ngrok_error = Some(msg);
                    format!("http://127.0.0.1:{}", port)
                }
            }
        } else {
            format!("http://127.0.0.1:{}", port)
        }
    } else {
        format!("http://127.0.0.1:{}", port)
    };

    *state.running.write() = true;
    *state.poller_handle.write() = Some(poller_handle);
    *state.http_handle.write() = Some(http_handle);
    *state.public_url.write() = Some(url.clone());

    if let Some(err) = ngrok_error {
        info!("Mail server started on {} (Local only due to Ngrok error: {})", url, err);
        Ok(format!("started_with_ngrok_error:{}", err))
    } else {
        info!("Mail server started on {}", url);
        Ok(url)
    }
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
