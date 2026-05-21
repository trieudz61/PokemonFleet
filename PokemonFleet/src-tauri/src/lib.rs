//! POKEIOSControl — Tauri lib crate.
//!
//! Entry point invoked by both the desktop binary (`main.rs`) and any future
//! mobile or library targets. Wires together state, plugins, and Tauri commands.

mod device;
mod fleet;
mod storage;
mod license;
mod bootstrap;
mod utils;
mod mail_server;

use std::sync::Arc;
use parking_lot::RwLock;
use tauri::Manager;

/// Global application state shared across Tauri commands.
pub struct AppState {
    pub devices: Arc<RwLock<device::registry::Registry>>,
    pub tunnel_pool: Arc<device::tunnel::TunnelPool>,
    pub api_client: Arc<device::api::ApiClient>,
    pub store: Arc<storage::store::Store>,
    pub log_streams: Arc<fleet::log_stream::LogStreamPool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging — env-controlled via RUST_LOG.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,pokeioscontrol=debug")),
        )
        .with_target(false)
        .compact()
        .init();

    tracing::info!("Starting POKEIOSControl v{}", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Initialise persistent store.
            let data_dir = app.path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("pokemonfleet.db");
            let store = Arc::new(storage::store::Store::open(&db_path)
                .expect("failed to open SQLite store"));

            // Build state.
            let state = AppState {
                devices: Arc::new(RwLock::new(device::registry::Registry::new())),
                tunnel_pool: Arc::new(device::tunnel::TunnelPool::new()),
                api_client: Arc::new(device::api::ApiClient::new()),
                store: store.clone(),
                log_streams: Arc::new(fleet::log_stream::LogStreamPool::new()),
            };

            // Spawn the discovery loop.
            let watcher_handle = app_handle.clone();
            let watcher_state = device::watcher::WatcherDeps {
                devices: state.devices.clone(),
                tunnel_pool: state.tunnel_pool.clone(),
                api_client: state.api_client.clone(),
                store: state.store.clone(),
                app: app_handle.clone(),
                log_streams: state.log_streams.clone(),
            };
            tauri::async_runtime::spawn(async move {
                let _ = watcher_handle; // suppress unused if logger disabled
                device::watcher::run(watcher_state).await;
            });

            // Mail server state
            let mail_state = Arc::new(mail_server::MailServerState::new());
            // Try to load saved mail config
            let mail_config_path = data_dir.join("mail_config.json");
            if let Some(cfg) = mail_server::config::MailConfig::load(&mail_config_path) {
                *mail_state.config.write() = Some(cfg);
            }
            app.manage(mail_state);

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Device commands
            fleet::commands::list_devices,
            fleet::commands::refresh_devices,
            fleet::commands::get_device_detail,
            fleet::commands::set_device_label,

            // Fleet commands
            fleet::commands::run_fleet,
            fleet::commands::stop_fleet,
            fleet::commands::run_single,
            fleet::commands::stop_single,
            fleet::commands::fast_run,

            // File / config
            fleet::commands::list_files,
            fleet::commands::read_file,
            fleet::commands::write_file,
            fleet::commands::delete_file,
            fleet::commands::read_config,
            fleet::commands::write_config,

            // Bootstrap
            bootstrap::install_pokemon_loader,

            // License
            license::verifier::verify_fleet_license,
            license::verifier::get_machine_id,
            license::verifier::get_cached_license,

            // Misc
            fleet::commands::get_ide_url,
            fleet::commands::get_pokemon_license,
            fleet::commands::open_external_url,

            // Mail server
            mail_server::commands::mail_server_status,
            mail_server::commands::mail_server_save_config,
            mail_server::commands::mail_server_load_config,
            mail_server::commands::mail_server_start,
            mail_server::commands::mail_server_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill ngrok process on app exit
                let mail_state: &Arc<mail_server::MailServerState> = app.state::<Arc<mail_server::MailServerState>>().inner();
                if let Some(pid) = mail_state.ngrok_pid.write().take() {
                    tracing::info!("App exiting — killing ngrok PID={}", pid);
                    mail_server::kill_process(pid);
                }
            }
        });
}
