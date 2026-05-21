//! Embedded iCloud Mail Server — replaces the Python ServerMailIcloud.
//!
//! Components:
//! - `config`: Mail server configuration (iCloud creds, ngrok)
//! - `imap_poller`: Async IMAP polling loop
//! - `http_api`: Axum HTTP server exposing /api/* endpoints
//! - `commands`: Tauri commands for UI interaction

pub mod config;
pub mod imap_poller;
pub mod http_api;
pub mod commands;

use std::sync::Arc;
use parking_lot::RwLock;
use tokio::task::JoinHandle;

use config::MailConfig;

/// Cached email entry.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CachedEmail {
    pub id: String,
    pub to: Vec<String>,
    pub hide_my_email: String,
    pub from: String,
    pub subject: String,
    pub date: String,
    pub received_at: String,
    pub body_text: String,
    pub body_html: String,
}

/// Shared state for the mail server subsystem.
pub struct MailServerState {
    pub config: RwLock<Option<MailConfig>>,
    pub emails: RwLock<Vec<CachedEmail>>,
    pub running: RwLock<bool>,
    pub imap_connected: RwLock<bool>,
    pub last_check: RwLock<Option<String>>,
    /// Handle to the IMAP poller task (so we can abort it).
    pub poller_handle: RwLock<Option<JoinHandle<()>>>,
    /// Handle to the HTTP server task.
    pub http_handle: RwLock<Option<JoinHandle<()>>>,
    /// The public URL (ngrok or local).
    pub public_url: RwLock<Option<String>>,
    /// Ngrok process PID (for killing on stop).
    pub ngrok_pid: RwLock<Option<u32>>,
}

impl MailServerState {
    pub fn new() -> Self {
        Self {
            config: RwLock::new(None),
            emails: RwLock::new(Vec::new()),
            running: RwLock::new(false),
            imap_connected: RwLock::new(false),
            last_check: RwLock::new(None),
            poller_handle: RwLock::new(None),
            http_handle: RwLock::new(None),
            public_url: RwLock::new(None),
            ngrok_pid: RwLock::new(None),
        }
    }
}

/// Cross-platform process termination by PID.
///
/// On Unix, sends SIGTERM. On Windows, calls TerminateProcess.
pub fn kill_process(pid: u32) {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}
