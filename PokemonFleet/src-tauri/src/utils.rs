//! Generic helpers used across modules.

use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the current Unix epoch in seconds. Used for `last_seen` and
/// timestamps written to the SQLite store.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
/// Resolves the absolute path to a binary.
///
/// Search order:
///   1. <exe-dir>/binaries/<name>            — dev + portable layouts
///   2. <exe-dir>/resources/binaries/<name>  — Windows MSI/NSIS install
///   3. plain `<name>` on PATH               — fallback
pub fn locate_binary(name: &str) -> std::path::PathBuf {
    let exe_name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{}.exe", name)
    } else {
        name.to_string()
    };

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            let candidate = dir.join("binaries").join(&exe_name);
            if candidate.is_file() {
                return candidate;
            }
            let resources = dir.join("resources").join("binaries").join(&exe_name);
            if resources.is_file() {
                return resources;
            }
        }
    }

    which::which(&exe_name).unwrap_or_else(|_| std::path::PathBuf::from(exe_name))
}
