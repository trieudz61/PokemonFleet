//! License verifier — talks to the Pokemon Worker at
//! `https://pokemon.ioscontrol.com/api/fleet/verify`.
//!
//! Behaviour:
//!   * Generate a stable machine ID once per install (SHA256 of best-effort
//!     hardware identifiers) and cache it in the store.
//!   * On `verify_fleet_license(key)`: POST {key, machine_id} → store the
//!     server response in `app_settings` and return it.
//!   * On `get_cached_license()`: return the cached payload without hitting
//!     the network.
//!
//! The actual gating (block fleet commands when expired) is enforced in
//! `lib.rs` on app start; this module just provides the primitives.

use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::State;

const VERIFY_URL: &str = "https://pokemon.ioscontrol.com/api/fleet/verify";
const SETTING_LICENSE_KEY: &str = "fleet_license_key";
const SETTING_LICENSE_PAYLOAD: &str = "fleet_license_payload";
const SETTING_MACHINE_ID: &str = "fleet_machine_id";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FleetLicensePayload {
    pub valid: bool,
    #[serde(default)] pub plan: Option<String>,
    #[serde(default)] pub expires_at: Option<i64>,
    #[serde(default)] pub max_devices: Option<i64>,
    #[serde(default)] pub message: Option<String>,
}

// ─────────────────────────── Commands ───────────────────────────────────

#[tauri::command]
pub fn get_machine_id(state: State<'_, AppState>) -> Result<String, String> {
    Ok(machine_id_or_init(&state))
}

#[tauri::command]
pub fn get_cached_license(state: State<'_, AppState>) -> Result<Option<FleetLicensePayload>, String> {
    let v = state.store.get_setting(SETTING_LICENSE_PAYLOAD).map_err(|e| e.to_string())?;
    match v {
        Some(s) => Ok(serde_json::from_str(&s).ok()),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn verify_fleet_license(
    state: State<'_, AppState>,
    key: String,
) -> Result<FleetLicensePayload, String> {
    let machine_id = machine_id_or_init(&state);

    let body = json!({ "key": key, "machine_id": machine_id });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp: Value = client.post(VERIFY_URL).json(&body).send().await
        .map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let payload: FleetLicensePayload = serde_json::from_value(resp.clone())
        .unwrap_or(FleetLicensePayload {
            valid: false,
            plan: None,
            expires_at: None,
            max_devices: None,
            message: Some("invalid server response".into()),
        });

    // Cache for offline-tolerant restarts.
    if payload.valid {
        state.store.set_setting(SETTING_LICENSE_KEY, &key).map_err(|e| e.to_string())?;
        state.store.set_setting(
            SETTING_LICENSE_PAYLOAD,
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
        ).map_err(|e| e.to_string())?;
    }

    Ok(payload)
}

// ─────────────────────────── Internals ──────────────────────────────────

fn machine_id_or_init(state: &State<'_, AppState>) -> String {
    if let Ok(Some(existing)) = state.store.get_setting(SETTING_MACHINE_ID) {
        return existing;
    }
    let id = compute_machine_id();
    state.store.set_setting(SETTING_MACHINE_ID, &id).ok();
    id
}

fn compute_machine_id() -> String {
    // We deliberately mix multiple weak signals — none alone is unique, but
    // their SHA256 is stable across reboots. We never send the raw values.
    let mut h = Sha256::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(guid) = read_machine_guid_windows() {
            h.update(guid.as_bytes());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(uuid) = read_hardware_uuid_macos() {
            h.update(uuid.as_bytes());
        }
    }

    if let Some(host) = hostname_best_effort() {
        h.update(host.as_bytes());
    }

    let digest = h.finalize();
    hex::encode(digest)
}

#[cfg(target_os = "windows")]
fn read_machine_guid_windows() -> std::io::Result<String> {
    // HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography\MachineGuid
    let out = std::process::Command::new("reg")
        .args([
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()?;
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            return Ok(line[idx + 6..].trim().to_string());
        }
    }
    Ok(String::new())
}

#[cfg(target_os = "macos")]
fn read_hardware_uuid_macos() -> std::io::Result<String> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()?;
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(eq) = line.find('=') {
                return Ok(line[eq + 1..].trim().trim_matches('"').to_string());
            }
        }
    }
    Ok(String::new())
}

fn hostname_best_effort() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output().ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        })
}
