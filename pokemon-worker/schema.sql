-- D1 Schema for Pokemon Script Delivery
-- Run: wrangler d1 execute POKEMON_DB --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT UNIQUE NOT NULL,
  udid TEXT NOT NULL,
  customer_name TEXT DEFAULT '',
  customer_contact TEXT DEFAULT '',
  plan TEXT DEFAULT 'monthly',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0,
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scripts (
  script_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  version TEXT DEFAULT '1.0.0',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS script_perms (
  license_id INTEGER NOT NULL,
  script_id TEXT NOT NULL,
  PRIMARY KEY (license_id, script_id),
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  FOREIGN KEY (script_id) REFERENCES scripts(script_id)
);

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER,
  script_id TEXT,
  ip TEXT,
  udid TEXT,
  ts INTEGER NOT NULL
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_udid ON licenses(udid);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON access_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_license ON access_logs(license_id);
