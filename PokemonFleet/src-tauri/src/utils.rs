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
