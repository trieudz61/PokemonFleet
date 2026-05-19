//! Device discovery loop.
//!
//! Periodically polls `idevice_id -l` to enumerate UDIDs of currently
//! plugged-in iPhones. New UDIDs trigger:
//!   1. Allocating an iproxy tunnel via `TunnelPool::ensure`
//!   2. Calling `/api/device/info` to populate name / model / iOS version
//!   3. Inserting / updating the Registry
//!   4. Emitting a Tauri event so the UI re-renders
//!
//! Removed UDIDs trigger tunnel teardown + registry cleanup + a different
//! event. The loop is *additive only* on errors — a single failed device
//! probe never affects the others.

use crate::device::{api::ApiClient, registry::{Device, LicenseSummary, Registry}, tunnel::TunnelPool};
use crate::fleet::log_stream::LogStreamPool;
use crate::storage::store::Store;
use crate::utils::now_unix;
use anyhow::Result;
use parking_lot::RwLock;
use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Bag of dependencies for the watcher loop. Avoids fat function signatures.
pub struct WatcherDeps {
    pub devices: Arc<RwLock<Registry>>,
    pub tunnel_pool: Arc<TunnelPool>,
    pub api_client: Arc<ApiClient>,
    pub store: Arc<Store>,
    pub app: AppHandle,
    pub log_streams: Arc<LogStreamPool>,
}

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub async fn run(deps: WatcherDeps) {
    tracing::info!("device watcher started");
    let mut prev: HashSet<String> = HashSet::new();

    loop {
        match enumerate_udids() {
            Ok(current) => {
                let cur_set: HashSet<String> = current.iter().cloned().collect();

                // Detect newly attached.
                for udid in cur_set.difference(&prev) {
                    if let Err(e) = handle_attach(&deps, udid).await {
                        tracing::warn!(udid = %udid, err = ?e, "attach failed");
                    }
                }

                // Detect detached.
                for udid in prev.difference(&cur_set) {
                    handle_detach(&deps, udid).await;
                }

                // Refresh online status of still-connected devices (cheap ping).
                for udid in cur_set.intersection(&prev) {
                    refresh_one(&deps, udid).await;
                }

                prev = cur_set;
            }
            Err(e) => {
                tracing::warn!(err = ?e, "idevice_id enumeration failed");
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Run `idevice_id -l` and return the list of UDIDs.
fn enumerate_udids() -> Result<Vec<String>> {
    let exe = if cfg!(windows) { "idevice_id.exe" } else { "idevice_id" };

    // Prefer bundled sidecar. Search order:
    //   1. <exe-dir>/binaries/<name>            — dev + portable layouts
    //   2. <exe-dir>/resources/binaries/<name>  — Windows MSI/NSIS install
    //   3. plain `idevice_id` on PATH           — dev macOS w/ Homebrew
    let path = if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            let candidate = dir.join("binaries").join(exe);
            let resources = dir.join("resources").join("binaries").join(exe);
            if candidate.is_file() {
                candidate
            } else if resources.is_file() {
                resources
            } else {
                which::which(exe)?
            }
        } else {
            which::which(exe)?
        }
    } else {
        which::which(exe)?
    };


    let mut cmd = Command::new(&path);
    cmd.arg("-l");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output()?;
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "idevice_id exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

async fn handle_attach(deps: &WatcherDeps, udid: &str) -> Result<()> {
    tracing::info!(udid = %udid, "device attached");

    // 1. Spawn iproxy tunnel.
    let port = deps.tunnel_pool.ensure(udid)?;

    // 2. Wait briefly for iproxy + iOS HTTP server to become reachable.
    let mut info = None;
    for attempt in 0..10 {
        tokio::time::sleep(Duration::from_millis(200 + attempt * 100)).await;
        match deps.api_client.device_info(port).await {
            Ok(d) => { info = Some(d); break; }
            Err(_) if attempt < 9 => continue,
            Err(e) => {
                tracing::warn!(udid = %udid, err = ?e, "/api/device/info unreachable");
                break;
            }
        }
    }

    let label = deps.store.get_device_label(udid).ok().flatten();

    let device = if let Some(d) = info {
        Device {
            udid: d.udid.clone().min_chars(udid),
            name: if d.name.is_empty() { fallback_name(udid) } else { d.name },
            label: label.clone(),
            product_type: d.model,
            ios_version: d.ios_version,
            port,
            online: true,
            has_loader: d.has_pokemon_loader,
            running_script: None,
            // Pokemon license fills in later via the get_pokemon_license
            // command (reads Pokemon_Config.txt → calls
            // pokemon.ioscontrol.com/api/license/info). The license blob in
            // /api/device/info belongs to the IOSControl tweak itself —
            // ignore it here so we don't show "PRO · 26d" from the wrong
            // licence system.
            license_summary: None,
            last_seen: now_unix(),
        }
    } else {
        // Online via USB (idevice_id sees it) but IOSControl tweak not
        // responding — could be IOSControl not installed yet.
        Device {
            udid: udid.to_string(),
            name: fallback_name(udid),
            label,
            product_type: String::new(),
            ios_version: String::new(),
            port,
            online: false,
            has_loader: false,
            running_script: None,
            license_summary: None,
            last_seen: now_unix(),
        }
    };

    // Persist + emit.
    deps.store.upsert_device(&device).ok();
    deps.devices.write().upsert(device.clone());
    deps.app.emit("device-connected", &device).ok();

    // Start streaming logs once the tweak is reachable.
    if device.online {
        deps.log_streams
            .ensure(device.udid.clone(), port, deps.app.clone(), deps.api_client.clone())
            .await;
    }
    Ok(())
}

async fn handle_detach(deps: &WatcherDeps, udid: &str) {
    tracing::info!(udid = %udid, "device detached");
    deps.log_streams.drop_stream(udid).await;
    deps.tunnel_pool.drop_tunnel(udid);
    deps.devices.write().remove(udid);
    deps.app.emit("device-disconnected", udid).ok();
}

async fn refresh_one(deps: &WatcherDeps, udid: &str) {
    let Some(port) = deps.tunnel_pool.port_for(udid) else { return };

    // Ping is cheap (2s timeout). Don't fail the loop on a single hiccup.
    let alive = deps.api_client.ping(port).await.is_ok();

    // Pull running status. We only OVERWRITE running_script when we get a
    // confident answer:
    //   * running=true  → use script_name (or fallback) — definitely running
    //   * running=false → None                       — definitely not running
    //   * request error → keep the previous value         — don't flicker
    let new_running: Option<Option<String>> = if alive {
        match deps.api_client.running_status(port).await {
            Ok(r) if r.running => {
                Some(Some(r.script_name.unwrap_or_else(|| "(running)".into())))
            }
            Ok(_) => Some(None),
            Err(_) => None,
        }
    } else {
        None
    };

    // Re-check whether the Pokemon loader is still installed. /api/device/info
    // surfaces this via has_pokemon_loader, so we trust whatever the device
    // reports. Skip on transport error to avoid clobbering on a flaky tick.
    let new_has_loader: Option<bool> = if alive {
        match deps.api_client.device_info(port).await {
            Ok(info) => Some(info.has_pokemon_loader),
            Err(_) => None,
        }
    } else {
        None
    };

    let mut reg = deps.devices.write();
    if let Some(dev) = reg.get_mut(udid) {
        let online_changed = dev.online != alive;
        let mut running_changed = false;
        if let Some(rs) = new_running {
            if dev.running_script != rs { running_changed = true; }
            dev.running_script = rs;
        }
        let mut loader_changed = false;
        if let Some(hl) = new_has_loader {
            if dev.has_loader != hl { loader_changed = true; }
            dev.has_loader = hl;
        }
        dev.online = alive;
        dev.last_seen = now_unix();
        if online_changed || running_changed || loader_changed {
            let snapshot = dev.clone();
            drop(reg);
            deps.app.emit("device-updated", &snapshot).ok();
        }
    }
}

fn fallback_name(udid: &str) -> String {
    let short = udid.chars().take(6).collect::<String>();
    format!("iPhone-{}", short)
}

// Tiny extension trait so we can defensively keep the Apple-real UDID even if
// the device responds with an empty string after a partial spoof.
trait MinChars {
    fn min_chars(self, fallback: &str) -> Self;
}
impl MinChars for String {
    fn min_chars(self, fallback: &str) -> Self {
        if self.len() < 20 { fallback.to_string() } else { self }
    }
}
