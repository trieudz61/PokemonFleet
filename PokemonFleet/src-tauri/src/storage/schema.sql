-- Schema applied on every launch (idempotent CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS devices (
    udid TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    ios_version TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    custom_label TEXT,
    auto_run_script TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS device_configs (
    udid TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (udid, key)
);

CREATE TABLE IF NOT EXISTS script_run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    udid TEXT NOT NULL,
    script_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT,
    log_excerpt TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_history_udid ON script_run_history(udid, started_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
