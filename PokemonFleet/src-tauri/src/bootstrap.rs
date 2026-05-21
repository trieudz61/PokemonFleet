//! Bootstrap a fresh device — upload PokemonLoader.lue and seed the config
//! template. The UI exposes this as the "Setup" wizard for any device whose
//! `/api/device/info` reports `has_pokemon_loader = false`.

use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

#[derive(Serialize)]
pub struct BootstrapResult {
    pub success: bool,
    pub udid: String,
    pub uploaded_loader: bool,
    pub uploaded_template: bool,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn install_pokemon_loader(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    udid: String,
    seed_config_template: bool,
) -> Result<BootstrapResult, String> {
    let port = state.devices.read().get(&udid)
        .map(|d| d.port)
        .ok_or_else(|| format!("device {} not connected", udid))?;

    // Locate bundled .lue resource. Tauri unpacks resources into the app's
    // resource dir at runtime, but in dev mode that path doesn't include
    // ../assets, so we fall back to a known relative location.
    let loader_bytes = read_resource(&app, "PokemonLoader.lue")?;

    // 1. Upload loader.
    let upload_resp: Value = state.api_client
        .upload_binary(port, "PokemonLoader.lue", &loader_bytes)
        .await
        .map_err(|e| e.to_string())?;
    let loader_ok = upload_resp.get("success").and_then(Value::as_bool).unwrap_or(false)
        || upload_resp.get("name").is_some();

    let mut tpl_ok = false;
    if seed_config_template {
        if let Ok(tpl_bytes) = read_resource(&app, "Pokemon_Config.template.txt") {
            if let Ok(tpl) = String::from_utf8(tpl_bytes) {
                if state.api_client.save_text(port, "Pokemon_Config.txt", &tpl).await.is_ok() {
                    tpl_ok = true;
                }
            }
        }
    }

    // Refresh has_loader flag in registry on success.
    if loader_ok {
        if let Ok(info) = state.api_client.device_info(port).await {
            if let Some(d) = state.devices.write().get_mut(&udid) {
                d.has_loader = info.has_pokemon_loader;
            }
        }
    }

    Ok(BootstrapResult {
        success: loader_ok,
        udid,
        uploaded_loader: loader_ok,
        uploaded_template: tpl_ok,
        message: if loader_ok { None } else { Some("upload failed".into()) },
    })
}

/// Resolve a bundled asset by name, with sensible dev-mode fallbacks.
///
/// Lookup order:
///   1. `<resource-root>/assets/<name>`     — production bundle path.
///   2. `<exe-dir>/../assets/<name>`        — `target/debug/...`.
///   3. `<exe-dir>/../../assets/<name>`     — nested target dirs.
///   4. `<CARGO_MANIFEST_DIR>/../assets/<name>` — `cargo run` from src-tauri.
fn read_resource(app: &tauri::AppHandle, name: &str) -> Result<Vec<u8>, String> {
    use std::path::PathBuf;

    let mut tried: Vec<PathBuf> = Vec::new();

    // 1a. Tauri-managed resource directory — file at root (Tauri 2 default).
    if let Ok(p) = app.path().resolve(
        name,
        tauri::path::BaseDirectory::Resource,
    ) {
        if p.is_file() { return std::fs::read(&p).map_err(|e| e.to_string()); }
        tried.push(p);
    }

    // 1b. Tauri-managed resource directory — nested in assets/ subfolder.
    if let Ok(p) = app.path().resolve(
        format!("assets/{}", name),
        tauri::path::BaseDirectory::Resource,
    ) {
        if p.is_file() { return std::fs::read(&p).map_err(|e| e.to_string()); }
        tried.push(p);
    }

    // 2. Look relative to the running executable — covers NSIS install layout.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Direct next to exe: <exe_dir>/<name>
            let c = exe_dir.join(name);
            if c.is_file() { return std::fs::read(&c).map_err(|e| e.to_string()); }
            tried.push(c);

            // <exe_dir>/assets/<name>
            let c = exe_dir.join("assets").join(name);
            if c.is_file() { return std::fs::read(&c).map_err(|e| e.to_string()); }
            tried.push(c);

            // Tauri 2 NSIS layout: <exe_dir>/_up_/assets/<name>
            let c = exe_dir.join("_up_").join("assets").join(name);
            if c.is_file() { return std::fs::read(&c).map_err(|e| e.to_string()); }
            tried.push(c);

            // Walk up from exe (covers target/debug, target/release, etc.)
            let mut cur = exe_dir.parent().map(|p| p.to_path_buf());
            for _ in 0..3 {
                let Some(dir) = cur.clone() else { break; };
                let candidate = dir.join("assets").join(name);
                if candidate.is_file() { return std::fs::read(&candidate).map_err(|e| e.to_string()); }
                tried.push(candidate);
                cur = dir.parent().map(|p| p.to_path_buf());
            }
        }
    }

    // 3. Compile-time-known project root — the canonical dev location.
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest_root.parent()
        .map(|p| p.join("assets").join(name))
        .unwrap_or_default();
    if candidate.is_file() { return std::fs::read(&candidate).map_err(|e| e.to_string()); }
    tried.push(candidate);

    Err(format!(
        "asset {} not found. Tried:\n{}",
        name,
        tried.iter().map(|p| format!("  - {}", p.display())).collect::<Vec<_>>().join("\n"),
    ))
}
