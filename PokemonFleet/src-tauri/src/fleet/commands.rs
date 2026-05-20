//! Tauri commands invoked from the UI.
//!
//! Every command:
//!   1. Pulls AppState (devices, api_client, store).
//!   2. Resolves UDID(s) -> port via the registry.
//!   3. Calls the per-device API and returns JSON-serializable payloads.
//!
//! Errors are mapped to `String` so they round-trip cleanly through
//! `tauri::ipc::InvokeResolver`.

use crate::device::registry::Device;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

// ─────────────────────────── Result type alias ────────────────────────────

pub type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String { e.to_string() }

// ─────────────────────────── Shared structs ───────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FleetCommandResult {
    pub udid: String,
    pub success: bool,
    pub message: Option<String>,
}

// ─────────────────────────── Device queries ───────────────────────────────

#[tauri::command]
pub async fn list_devices(state: State<'_, AppState>) -> CmdResult<Vec<Device>> {
    Ok(state.devices.read().snapshot())
}

#[tauri::command]
pub async fn refresh_devices(state: State<'_, AppState>) -> CmdResult<Vec<Device>> {
    // The watcher is already polling every 2s. This command lets the UI ask
    // for an immediate snapshot — no extra work needed.
    Ok(state.devices.read().snapshot())
}

#[tauri::command]
pub async fn get_device_detail(
    state: State<'_, AppState>,
    udid: String,
) -> CmdResult<Value> {
    let port = port_for(&state, &udid)?;
    state.api_client.device_info(port).await
        .map(|info| serde_json::to_value(info).unwrap_or(Value::Null))
        .map_err(err)
}

#[tauri::command]
pub async fn set_device_label(
    state: State<'_, AppState>,
    udid: String,
    label: Option<String>,
) -> CmdResult<()> {
    state.store.set_device_label(&udid, label.as_deref()).map_err(err)?;
    if let Some(d) = state.devices.write().get_mut(&udid) {
        d.label = label;
    }
    Ok(())
}

// ─────────────────────────── Fleet run/stop ───────────────────────────────

#[tauri::command]
pub async fn run_fleet(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udids: Vec<String>,
    script_name: String,
) -> CmdResult<Vec<FleetCommandResult>> {
    let targets = resolve_targets(&state, &udids);
    let api = state.api_client.clone();
    let script = std::sync::Arc::new(script_name);

    let futures = targets.into_iter().map(|(udid, port)| {
        let api = api.clone();
        let script = script.clone();
        async move {
            match api.run_script(port, &script).await {
                Ok(r) if r.success => FleetCommandResult {
                    udid, success: true,
                    message: r.task_id.or(Some("started".into())),
                },
                Ok(r) => FleetCommandResult {
                    udid, success: false,
                    message: r.error.or(r.detail).or(Some("unknown error".into())),
                },
                Err(e) => FleetCommandResult {
                    udid, success: false, message: Some(e.to_string()),
                },
            }
        }
    });
    let results = futures::future::join_all(futures).await;
    flip_running(&state, &app, &results, Some(script.as_str().to_string()));
    Ok(results)
}

#[tauri::command]
pub async fn stop_fleet(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udids: Vec<String>,
) -> CmdResult<Vec<FleetCommandResult>> {
    let targets = resolve_targets(&state, &udids);
    let api = state.api_client.clone();
    let futures = targets.into_iter().map(|(udid, port)| {
        let api = api.clone();
        async move {
            match api.stop_script(port).await {
                Ok(_) => FleetCommandResult {
                    udid, success: true, message: Some("stopped".into()),
                },
                Err(e) => FleetCommandResult {
                    udid, success: false, message: Some(e.to_string()),
                },
            }
        }
    });
    let results = futures::future::join_all(futures).await;
    flip_running(&state, &app, &results, None);
    Ok(results)
}

#[tauri::command]
pub async fn run_single(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udid: String,
    script_name: String,
) -> CmdResult<FleetCommandResult> {
    let port = port_for(&state, &udid)?;
    let result = match state.api_client.run_script(port, &script_name).await {
        Ok(r) if r.success => FleetCommandResult {
            udid: udid.clone(), success: true,
            message: r.task_id.or(Some("started".into())),
        },
        Ok(r) => FleetCommandResult {
            udid: udid.clone(), success: false,
            message: r.error.or(r.detail),
        },
        Err(e) => return Err(err(e)),
    };
    flip_running(&state, &app, std::slice::from_ref(&result), Some(script_name.clone()));
    Ok(result)
}

#[tauri::command]
pub async fn stop_single(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udid: String,
) -> CmdResult<FleetCommandResult> {
    let port = port_for(&state, &udid)?;
    state.api_client.stop_script(port).await.map_err(err)?;
    let result = FleetCommandResult { udid: udid.clone(), success: true, message: Some("stopped".into()) };
    flip_running(&state, &app, std::slice::from_ref(&result), None);
    Ok(result)
}

// ────────────────────── Fast run (skip menu) ──────────────────────────
//
// Skips the loader's interactive menu by:
//   1. Reading LICENSE_KEY from each device's Pokemon_Config.txt
//   2. POSTing {key, udid, script, nonce, loader_version} to
//      pokemon.ioscontrol.com/api/script/get — server returns XOR-encrypted
//      payload + iv
//   3. Decrypting locally with key = udid + nonce + iv (same scheme as
//      PokemonLoader.lua's xorBytes)
//   4. Wrapping the decrypted code in a Lua bootstrap that loads CONFIG
//      from Pokemon_Config.txt and runs the source
//   5. POSTing the wrapper to /api/scripts/run on each device
//
// If a device doesn't have permission for the script, the worker returns
// `no_permission` and we surface that as a per-device error — the user sees
// which iPhone needs an upgrade without blocking the rest of the fleet.

#[tauri::command]
pub async fn fast_run(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udids: Vec<String>,
    script_id: String,
    script_label: Option<String>,
) -> CmdResult<Vec<FleetCommandResult>> {
    let targets = resolve_targets(&state, &udids);
    if targets.is_empty() {
        return Ok(vec![]);
    }

    let api = state.api_client.clone();
    let script_id = std::sync::Arc::new(script_id);

    // Spin them all up in parallel. Each task does the read-config →
    // worker fetch → decrypt → run dance independently so a slow device
    // doesn't block the rest.
    let futures = targets.into_iter().map(|(udid, port)| {
        let api = api.clone();
        let script_id = script_id.clone();
        async move {
            match fast_run_single(&api, port, &udid, &script_id).await {
                Ok(()) => FleetCommandResult { udid, success: true,
                    message: Some("started".into()) },
                Err(e) => FleetCommandResult { udid, success: false,
                    message: Some(e) },
            }
        }
    });
    let results = futures::future::join_all(futures).await;
    let label = script_label.unwrap_or_else(|| script_id.as_str().to_string());
    flip_running(&state, &app, &results, Some(label));
    Ok(results)
}

async fn fast_run_single(
    api: &crate::device::api::ApiClient,
    port: u16,
    udid: &str,
    script_id: &str,
) -> Result<(), String> {
    // 1. Read Pokemon_Config.txt for LICENSE_KEY.
    let cfg_bytes = api.download_file(port, "Pokemon_Config.txt").await
        .map_err(|e| format!("Đọc Pokemon_Config.txt lỗi: {}", e))?;
    let cfg_text = String::from_utf8_lossy(&cfg_bytes);
    let license_key = cfg_text.lines()
        .filter_map(|l| l.trim().strip_prefix("LICENSE_KEY=").map(|v| v.trim().to_string()))
        .find(|v| !v.is_empty())
        .ok_or_else(|| "Chưa có LICENSE_KEY trong Pokemon_Config.txt".to_string())?;

    // 2. Hit pokemon.ioscontrol.com/api/script/get.
    let nonce = random_hex(32);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp: serde_json::Value = client
        .post("https://pokemon.ioscontrol.com/api/script/get")
        .json(&serde_json::json!({
            "key":            license_key,
            "udid":           udid,
            "script":         script_id,
            "nonce":          nonce,
            "loader_version": "fleet/0.1.0",
        }))
        .send().await.map_err(|e| format!("Mạng lỗi: {}", e))?
        .json().await.map_err(|e| format!("Server trả về invalid: {}", e))?;

    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let reason = resp.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(reason_to_message(reason).to_string());
    }
    let payload_hex = resp.get("payload").and_then(|v| v.as_str())
        .ok_or_else(|| "Server thiếu payload".to_string())?;
    let iv = resp.get("iv").and_then(|v| v.as_str())
        .ok_or_else(|| "Server thiếu iv".to_string())?;

    // 3. Decrypt: XOR(payload, udid + nonce + iv).
    let cipher = hex::decode(payload_hex).map_err(|e| format!("Decode hex lỗi: {}", e))?;
    let xkey = format!("{}{}{}", udid, nonce, iv);
    let plain_bytes = xor_bytes(&cipher, xkey.as_bytes());
    let plain = String::from_utf8(plain_bytes)
        .map_err(|_| "Decrypt fail — sai key/UDID".to_string())?;

    // 4. Build Lua wrapper that injects CONFIG before running.
    let wrapper = build_wrapper(&cfg_text, &plain, script_id);

    // 5. POST to /api/scripts/run.
    let result = api.run_script_with_code(port, script_id, &wrapper).await
        .map_err(|e| format!("Run failed: {}", e))?;
    if !result.success {
        return Err(result.error.or(result.detail).unwrap_or_else(|| "unknown error".into()));
    }
    Ok(())
}

/// Map worker reason codes to user-friendly Vietnamese messages.
fn reason_to_message(reason: &str) -> &str {
    match reason {
        "invalid_key"   => "❌ Key không hợp lệ",
        "udid_mismatch" => "❌ Key không đúng máy này",
        "expired"       => "❌ Key hết hạn",
        "revoked"       => "❌ Key bị thu hồi",
        "no_permission" => "⛔ Key chưa mua script này",
        "rate_limit"    => "⏱ Quá nhiều request — thử lại sau 1 phút",
        _               => "❌ Lỗi không xác định",
    }
}

fn xor_bytes(data: &[u8], key: &[u8]) -> Vec<u8> {
    let klen = key.len();
    if klen == 0 { return data.to_vec(); }
    data.iter().enumerate()
        .map(|(i, b)| b ^ key[i % klen])
        .collect()
}

fn random_hex(n: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; (n + 1) / 2];
    rand::thread_rng().fill_bytes(&mut buf);
    let s = hex::encode(&buf);
    s[..n].to_string()
}

/// Wrap the decrypted source so it parses Pokemon_Config.txt into a CONFIG
/// table (just like PokemonLoader.lua does) before executing.
fn build_wrapper(_cfg_text: &str, source: &str, script_id: &str) -> String {
    // We embed the raw config text via the device itself — readFile is
    // available in the Lua sandbox — so we don't have to escape multiline
    // strings on the host. The wrapper is small + identical for every
    // device, only the source body changes.
    let escaped = source.replace("]==]", "] = =]"); // defang the long-string terminator
    format!(r#"
-- POKEIOSControl fast-run wrapper for {script_id}
local _cfgText = readFile("Pokemon_Config.txt") or ""
local CONFIG = {{}}
for line in _cfgText:gmatch("[^\r\n]+") do
    local trimmed = line:match("^%s*(.-)%s*$")
    if trimmed ~= "" and not trimmed:match("^#") then
        local k, v = trimmed:match("^([%w_]+)%s*=%s*(.-)$")
        if k then
            v = v:gsub('^["\']', ''):gsub('["\']$', '')
            CONFIG[k] = v
        end
    end
end

local _src = [==[
{escaped}
]==]
local _fn, _err = load(_src, "={script_id}", "t", setmetatable({{CONFIG = CONFIG}}, {{__index = _G}}))
if not _fn then error("FastRun parse error: " .. tostring(_err)) end
_fn()
"#)
}

/// Optimistically push the new `running_script` value into the registry and
/// emit `device-updated`. Avoids racing the device by NOT re-polling
/// `/api/scripts/running` immediately — the 2-second watcher tick will
/// reconcile if reality drifts.
fn flip_running(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    results: &[FleetCommandResult],
    running_script: Option<String>,
) {
    use tauri::Emitter;
    for r in results.iter().filter(|r| r.success) {
        let snapshot = {
            let mut reg = state.devices.write();
            if let Some(d) = reg.get_mut(&r.udid) {
                d.running_script = running_script.clone();
                Some(d.clone())
            } else { None }
        };
        if let Some(d) = snapshot { app.emit("device-updated", &d).ok(); }
    }
}

// ─────────────────────────── Files & config ───────────────────────────────

#[tauri::command]
pub async fn list_files(state: State<'_, AppState>, udid: String) -> CmdResult<Value> {
    let port = port_for(&state, &udid)?;
    state.api_client.list_files(port).await.map_err(err)
}

#[tauri::command]
pub async fn read_file(
    state: State<'_, AppState>,
    udid: String,
    name: String,
) -> CmdResult<String> {
    let port = port_for(&state, &udid)?;
    let bytes = state.api_client.download_file(port, &name).await.map_err(err)?;
    // For text files this is the actual content. For binary we still return
    // bytes-as-utf8-lossy so the UI can decide what to do.
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    udid: String,
    name: String,
    content: String,
) -> CmdResult<Value> {
    let port = port_for(&state, &udid)?;
    state.api_client.save_text(port, &name, &content).await.map_err(err)
}

#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    udid: String,
    name: String,
) -> CmdResult<Value> {
    let port = port_for(&state, &udid)?;
    state.api_client.delete_file(port, &name).await.map_err(err)
}

/// Read Pokemon_Config.txt and parse it into a KEY=VALUE map.
#[tauri::command]
pub async fn read_config(
    state: State<'_, AppState>,
    udid: String,
) -> CmdResult<std::collections::BTreeMap<String, String>> {
    let port = port_for(&state, &udid)?;
    let bytes = match state.api_client.download_file(port, "Pokemon_Config.txt").await {
        Ok(b) => b,
        Err(_) => return Ok(Default::default()), // missing == empty form
    };
    let text = String::from_utf8_lossy(&bytes);
    Ok(parse_kv(&text))
}

/// Serialize a KEY=VALUE map back to Pokemon_Config.txt.
#[tauri::command]
pub async fn write_config(
    state: State<'_, AppState>,
    udid: String,
    config: std::collections::BTreeMap<String, String>,
) -> CmdResult<Value> {
    let port = port_for(&state, &udid)?;
    let body: String = config.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n");
    state.api_client.save_text(port, "Pokemon_Config.txt", &body).await.map_err(err)
}

// ─────────────────────────── Utility ──────────────────────────────────────

#[tauri::command]
pub async fn get_ide_url(
    state: State<'_, AppState>,
    udid: String,
) -> CmdResult<String> {
    let port = port_for(&state, &udid)?;
    Ok(format!("http://localhost:{}/ide", port))
}

/// Resolve the Pokemon license (not IOSControl) for a device.
///
/// Flow:
///   1. GET /api/scripts/download?name=Pokemon_Config.txt from the device
///   2. Parse `LICENSE_KEY=...`
///   3. POST {key, udid} to https://pokemon.ioscontrol.com/api/license/info
///   4. Update the registry's license_summary so DeviceTable shows the right badge
///
/// Returns the parsed plan / days_left so the UI can apply optimistic updates
/// without waiting for the next watcher refresh.
#[tauri::command]
pub async fn get_pokemon_license(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    udid: String,
) -> CmdResult<serde_json::Value> {
    use crate::device::registry::LicenseSummary;
    use tauri::Emitter;

    let port = port_for(&state, &udid)?;

    // Fetch config file.
    let bytes = state.api_client
        .download_file(port, "Pokemon_Config.txt")
        .await
        .map_err(err)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut license_key: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("LICENSE_KEY=") {
            let v = rest.trim();
            if !v.is_empty() { license_key = Some(v.to_string()); break; }
        }
    }
    let key = license_key.ok_or_else(|| "LICENSE_KEY not set in Pokemon_Config.txt".to_string())?;

    // Hit the Pokemon worker.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(err)?;
    let resp: serde_json::Value = client
        .post("https://pokemon.ioscontrol.com/api/license/info")
        .json(&serde_json::json!({ "key": key, "udid": udid }))
        .send().await.map_err(err)?
        .json().await.map_err(err)?;

    // Update registry summary.
    let licensed = resp.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let days_left = resp.get("days_left").and_then(serde_json::Value::as_i64);

    let summary = LicenseSummary {
        licensed,
        // Keep the badge short — "PRO" reads cleanly in the 150px cell.
        // Customer name lives in the device label column instead.
        plan: if licensed { Some("PRO".to_string()) } else { None },
        days_left: if licensed { days_left } else { None },
    };

    let mut updated_device = None;
    {
        let mut reg = state.devices.write();
        if let Some(d) = reg.get_mut(&udid) {
            d.license_summary = Some(summary.clone());
            updated_device = Some(d.clone());
        }
    }
    if let Some(d) = updated_device {
        app.emit("device-updated", &d).ok();
    }
    Ok(resp)
}

#[tauri::command]
pub async fn open_external_url(
    app: tauri::AppHandle,
    url: String,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(&url, None::<&str>).map_err(err)
}

// ─────────────────────────── Helpers ──────────────────────────────────────

fn port_for(state: &State<'_, AppState>, udid: &str) -> CmdResult<u16> {
    state.devices.read().get(udid)
        .map(|d| d.port)
        .ok_or_else(|| format!("device {} not connected", udid))
}

/// Maps the requested UDIDs to (udid, port) pairs, dropping any UDIDs that
/// aren't currently in the registry. Empty input means "all online devices".
fn resolve_targets(state: &State<'_, AppState>, udids: &[String]) -> Vec<(String, u16)> {
    let reg = state.devices.read();
    if udids.is_empty() {
        reg.snapshot().into_iter()
            .filter(|d| d.online)
            .map(|d| (d.udid, d.port))
            .collect()
    } else {
        udids.iter()
            .filter_map(|u| reg.get(u).map(|d| (d.udid.clone(), d.port)))
            .collect()
    }
}

fn parse_kv(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some(idx) = line.find('=') {
            let (k, v) = line.split_at(idx);
            out.insert(k.trim().to_string(), v[1..].trim().to_string());
        }
    }
    out
}
