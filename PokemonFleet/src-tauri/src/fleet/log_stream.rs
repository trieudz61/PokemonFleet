//! Per-device log streaming via incremental polling.
//!
//! IOSControl exposes log lines through `/api/scripts/<taskId>/status?from=<n>`.
//! The taskId is set when /api/scripts/run succeeds and cleared when the
//! script ends. We poll `/api/scripts/running` to discover the active taskId,
//! then drain its status endpoint with a cursor until the script ends.
//!
//! Each new line is emitted as a Tauri event:
//!   * `log:<udid>` — per-device channel for the LogModal
//!   * `log`        — global channel for any fleet-wide consumers
//!
//! When `running=false`, we keep polling at a slower cadence so the consumer
//! reattaches when the user starts a new script.

use crate::device::api::ApiClient;
use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

const POLL_RUNNING_IDLE:    Duration = Duration::from_millis(1500);
const POLL_RUNNING_ACTIVE:  Duration = Duration::from_millis(500);

#[derive(Clone, serde::Serialize)]
pub struct LogPayload {
    pub udid: String,
    pub message: String,
}

/// Spawn a background task polling logs for a single device.
pub fn spawn(
    udid: String,
    port: u16,
    app: AppHandle,
    _api: Arc<ApiClient>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(e) = run(udid.clone(), port, app.clone()).await {
            tracing::warn!(udid = %udid, err = ?e, "log stream ended");
        }
    })
}

async fn run(udid: String, port: u16, app: AppHandle) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;

    let base = format!("http://127.0.0.1:{}", port);
    let mut active_task: Option<String> = None;
    let mut cursor: i64 = 0;

    loop {
        // Discover (or refresh) the running task id.
        let running_url = format!("{}/api/scripts/running", base);
        let running_task: Option<String> = match client.get(&running_url).send().await {
            Ok(r) => match r.json::<serde_json::Value>().await {
                Ok(v) => {
                    let is_running = v.get("running").and_then(|x| x.as_bool()).unwrap_or(false);
                    if is_running {
                        v.get("taskId").and_then(|x| x.as_str()).map(String::from)
                    } else { None }
                }
                Err(_) => None,
            },
            Err(_) => None,
        };

        match (&running_task, &active_task) {
            (Some(new_id), Some(old_id)) if new_id != old_id => {
                // A different script started — reset cursor.
                active_task = Some(new_id.clone());
                cursor = 0;
            }
            (Some(new_id), None) => {
                active_task = Some(new_id.clone());
                cursor = 0;
            }
            (None, Some(_)) => {
                // Script ended — drain anything left, then idle.
                if let Some(id) = active_task.take() {
                    let _ = drain_task(&client, &base, &id, &mut cursor, &udid, &app).await;
                }
            }
            _ => {}
        }

        if let Some(task_id) = active_task.clone() {
            // Active: poll fast.
            let _ = drain_task(&client, &base, &task_id, &mut cursor, &udid, &app).await;
            tokio::time::sleep(POLL_RUNNING_ACTIVE).await;
        } else {
            tokio::time::sleep(POLL_RUNNING_IDLE).await;
        }
    }
}

async fn drain_task(
    client: &reqwest::Client,
    base: &str,
    task_id: &str,
    cursor: &mut i64,
    udid: &str,
    app: &AppHandle,
) -> Result<()> {
    let url = format!("{}/api/scripts/{}/status", base, task_id);
    let resp = client.get(&url).query(&[("from", *cursor)]).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("HTTP {}", resp.status()));
    }
    let value: serde_json::Value = resp.json().await?;

    let total = value.get("totalLines")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(*cursor);

    if total < *cursor {
        // Console was reset (new run reused taskId — unlikely but defensive).
        *cursor = 0;
    }

    if let Some(arr) = value.get("logs").and_then(serde_json::Value::as_array) {
        for item in arr {
            let msg = item.get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            if msg.is_empty() { continue; }
            let payload = LogPayload {
                udid: udid.to_string(),
                message: msg,
            };
            app.emit(&format!("log:{}", udid), &payload).ok();
            app.emit("log", &payload).ok();
        }
    }
    *cursor = total;
    Ok(())
}

/// Convenience: connect or reconnect a stream when a device comes online.
pub struct LogStreamPool {
    inner: Arc<Mutex<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl LogStreamPool {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Default::default())) }
    }

    pub async fn ensure(&self, udid: String, port: u16, app: AppHandle, api: Arc<ApiClient>) {
        let mut map = self.inner.lock().await;
        if map.contains_key(&udid) { return; }
        let handle = spawn(udid.clone(), port, app, api);
        map.insert(udid, handle);
    }

    pub async fn drop_stream(&self, udid: &str) {
        let mut map = self.inner.lock().await;
        if let Some(h) = map.remove(udid) {
            h.abort();
        }
    }
}
