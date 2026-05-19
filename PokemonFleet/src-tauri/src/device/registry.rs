//! In-memory registry of currently connected devices.
//!
//! Acts as the single source of truth for the running app. The watcher updates
//! this on plug / unplug events, the UI reads from it via `list_devices`, and
//! fleet commands resolve UDID → port through it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One connected iPhone — the canonical record passed to the UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    /// 40-char Apple UDID (real, from libimobiledevice — independent of any
    /// runtime spoof on the device).
    pub udid: String,
    /// Display name from the device (set in iOS Settings → General).
    pub name: String,
    /// User-defined nickname stored in SQLite. Falls back to `name` if unset.
    pub label: Option<String>,
    /// e.g. "iPhone14,2".
    pub product_type: String,
    /// e.g. "16.4".
    pub ios_version: String,
    /// localhost port allocated by the tunnel pool (iproxy → 9999).
    pub port: u16,
    /// True once iproxy is up AND the IOSControl HTTP server has answered /ping.
    pub online: bool,
    /// Whether PokemonLoader.lue is already installed on the device.
    pub has_loader: bool,
    /// Live status from /api/scripts/running. None = unknown / unfetched.
    pub running_script: Option<String>,
    /// Pokemon license info (key, plan, days_left). None = no license attached.
    pub license_summary: Option<LicenseSummary>,
    /// Unix timestamp of the last successful /api/device/info poll.
    pub last_seen: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LicenseSummary {
    pub licensed: bool,
    pub plan: Option<String>,
    pub days_left: Option<i64>,
}

/// Backing store. We hold a HashMap keyed by UDID inside a parking_lot::RwLock
/// at the AppState level (see `lib.rs::AppState`), so this struct stays !Send-
/// agnostic and cheap to clone for snapshots.
#[derive(Default)]
pub struct Registry {
    inner: HashMap<String, Device>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert(&mut self, device: Device) {
        self.inner.insert(device.udid.clone(), device);
    }

    pub fn remove(&mut self, udid: &str) -> Option<Device> {
        self.inner.remove(udid)
    }

    pub fn get(&self, udid: &str) -> Option<&Device> {
        self.inner.get(udid)
    }

    pub fn get_mut(&mut self, udid: &str) -> Option<&mut Device> {
        self.inner.get_mut(udid)
    }

    pub fn contains(&self, udid: &str) -> bool {
        self.inner.contains_key(udid)
    }

    pub fn udids(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }

    /// Snapshot for the UI — sorted by label / name for stable rendering.
    pub fn snapshot(&self) -> Vec<Device> {
        let mut v: Vec<Device> = self.inner.values().cloned().collect();
        v.sort_by(|a, b| {
            let an = a.label.as_deref().unwrap_or(&a.name);
            let bn = b.label.as_deref().unwrap_or(&b.name);
            an.cmp(bn)
        });
        v
    }
}
