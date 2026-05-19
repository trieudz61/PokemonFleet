-- D1 migration for PokemonFleet desktop app license system.
--
-- Apply with:
--   wrangler d1 execute pokemon-scripts --file=migrations/001_fleet_licenses.sql --remote
--
-- (or --local for dev)

CREATE TABLE IF NOT EXISTS fleet_licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key TEXT UNIQUE NOT NULL,
    machine_id TEXT,
    plan TEXT NOT NULL DEFAULT 'monthly',  -- 'trial' | 'monthly' | 'yearly' | 'lifetime'
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 10,
    revoked INTEGER NOT NULL DEFAULT 0,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_fleet_licenses_machine ON fleet_licenses(machine_id);
