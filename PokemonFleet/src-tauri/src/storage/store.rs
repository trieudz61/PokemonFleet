//! Persistent SQLite store.
//!
//! Schema is in `schema.sql`. We use rusqlite with the `bundled` feature so
//! the build is self-contained — no system SQLite required on Windows.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

use crate::device::registry::Device;

const SCHEMA: &str = include_str!("schema.sql");

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("open sqlite at {:?}", path))?;
        // WAL = better concurrency for the watcher + UI commands.
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA).context("apply schema")?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ── devices ────────────────────────────────────────────────────────

    pub fn upsert_device(&self, d: &Device) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO devices (udid, name, model, ios_version, port, last_seen, custom_label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(udid) DO UPDATE SET
                name=excluded.name,
                model=excluded.model,
                ios_version=excluded.ios_version,
                port=excluded.port,
                last_seen=excluded.last_seen",
            params![
                d.udid,
                d.name,
                d.product_type,
                d.ios_version,
                d.port as i64,
                d.last_seen,
                d.label,
            ],
        )?;
        Ok(())
    }

    pub fn get_device_label(&self, udid: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let label: Option<String> = conn
            .query_row(
                "SELECT custom_label FROM devices WHERE udid = ?1",
                params![udid],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(label)
    }

    pub fn set_device_label(&self, udid: &str, label: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET custom_label = ?1 WHERE udid = ?2",
            params![label, udid],
        )?;
        Ok(())
    }

    // ── settings ───────────────────────────────────────────────────────

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── run history ────────────────────────────────────────────────────

    pub fn record_run(
        &self,
        udid: &str,
        script_id: &str,
        started_at: i64,
        ended_at: Option<i64>,
        status: &str,
        log_excerpt: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO script_run_history (udid, script_id, started_at, ended_at, status, log_excerpt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![udid, script_id, started_at, ended_at, status, log_excerpt],
        )?;
        Ok(())
    }
}
