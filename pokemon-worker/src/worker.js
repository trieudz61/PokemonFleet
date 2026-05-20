/**
 * Pokemon Script Delivery Worker
 * 
 * Endpoints:
 *   POST /api/script/get     — Device fetch encrypted source
 *   POST /admin/licenses     — Create license
 *   GET  /admin/licenses     — List licenses
 *   DELETE /admin/licenses/:id — Revoke license
 *   POST /admin/scripts      — Upload/update script
 *   GET  /admin/scripts      — List scripts
 *   GET  /admin/logs         — Access logs
 *   GET  /                   — Admin panel HTML
 */

import ADMIN_HTML from "./admin.html";
import LANDING_HTML from "./landing.html";


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // ─── Device API ───
      if (path === "/api/script/get" && request.method === "POST") {
        return handleGetScript(request, env);
      }
      if (path === "/api/license/info" && request.method === "POST") {
        return handleLicenseInfo(request, env);
      }

      // ─── Data Registry (file manifest per script) ───
      if (path === "/api/scripts/data-registry" && request.method === "GET") {
        return handleDataRegistry(env);
      }

      // ─── Public read-only ───
      // Used by PokemonFleet's script picker dropdown — no auth required
      // because it only exposes script_id + name + version (no source code).
      if (path === "/api/scripts/list" && request.method === "GET") {
        return handlePublicScriptList(env);
      }

      // ─── Fleet (PokemonFleet desktop) license ───
      if (path === "/api/fleet/verify" && request.method === "POST") {
        return handleFleetVerify(request, env);
      }

      // ─── Admin API (token-protected) ───
      if (path.startsWith("/admin/")) {
        const token = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (token !== env.ADMIN_TOKEN) {
          return json(401, { ok: false, reason: "unauthorized" });
        }

        if (path === "/admin/licenses" && request.method === "POST") {
          return handleCreateLicense(request, env);
        }
        if (path === "/admin/licenses" && request.method === "GET") {
          return handleListLicenses(request, env);
        }
        if (path.match(/^\/admin\/licenses\/\d+\/permanent$/) && request.method === "DELETE") {
          const id = parseInt(path.split("/")[3]);
          return handleDeleteLicense(id, env);
        }
        if (path.match(/^\/admin\/licenses\/\d+$/) && request.method === "DELETE") {
          const id = parseInt(path.split("/").pop());
          return handleRevokeLicense(id, env);
        }
        if (path.match(/^\/admin\/licenses\/\d+\/scripts$/) && request.method === "PATCH") {
          const id = parseInt(path.split("/")[3]);
          return handleUpdateLicenseScripts(id, request, env);
        }
        if (path.match(/^\/admin\/licenses\/\d+$/) && request.method === "PUT") {
          const id = parseInt(path.split("/").pop());
          return handleUnlockLicense(id, env);
        }
        if (path === "/admin/scripts" && request.method === "POST") {
          return handleUploadScript(request, env);
        }
        if (path === "/admin/scripts" && request.method === "GET") {
          return handleListScripts(env);
        }
        if (path.match(/^\/admin\/scripts\/[\w-]+$/) && request.method === "GET") {
          const scriptId = path.split("/").pop();
          return handleGetScript_admin(scriptId, env);
        }
        if (path.match(/^\/admin\/scripts\/[\w-]+$/) && request.method === "PUT") {
          const scriptId = path.split("/").pop();
          return handleRenameScript(scriptId, request, env);
        }
        if (path.match(/^\/admin\/scripts\/[\w-]+$/) && request.method === "DELETE") {
          const scriptId = path.split("/").pop();
          return handleDeleteScript(scriptId, env);
        }
        if (path === "/admin/logs" && request.method === "GET") {
          return handleLogs(request, env);
        }

        // Fleet license admin
        if (path === "/admin/fleet/licenses" && request.method === "GET") {
          return handleListFleetLicenses(env);
        }
        if (path === "/admin/fleet/licenses" && request.method === "POST") {
          return handleCreateFleetLicense(request, env);
        }
        if (path.match(/^\/admin\/fleet\/licenses\/\d+$/) && request.method === "DELETE") {
          const id = parseInt(path.split("/").pop());
          return handleRevokeFleetLicense(id, env);
        }
      }

      // ─── Health ───
      if (path === "/ping") {
        return json(200, { ok: true, service: "pokemon-script-worker", ts: Date.now() });
      }

      // ─── Admin Panel (HTML) ───
      if (path === "/admin" || path === "/admin/") {
        return new Response(ADMIN_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ─── Landing Page ───
      if (path === "/" || path === "/index.html") {
        return new Response(LANDING_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return json(404, { ok: false, reason: "not_found" });
    } catch (e) {
      console.error("Worker error:", e);
      return json(500, { ok: false, reason: "internal_error", detail: e.message });
    }
  }
};

// ═══════════════════════════════════════════
// DEVICE: GET SCRIPT
// ═══════════════════════════════════════════

async function handleGetScript(request, env) {
  const body = await request.json();
  const { key, udid, script, nonce, loader_version } = body;

  if (!key || !udid || !script || !nonce) {
    return json(400, { ok: false, reason: "missing_fields" });
  }

  // Rate limit (30 req/min per key)
  const rateLimited = await checkRateLimit(env, key);
  if (rateLimited) {
    return json(429, { ok: false, reason: "rate_limit" });
  }

  // Verify license
  const license = await env.DB.prepare(
    "SELECT * FROM licenses WHERE license_key = ?"
  ).bind(key).first();

  if (!license) return json(200, { ok: false, reason: "invalid_key" });
  if (license.revoked) return json(200, { ok: false, reason: "revoked" });
  if (license.udid !== udid) return json(200, { ok: false, reason: "udid_mismatch" });

  const now = Math.floor(Date.now() / 1000);
  if (now > license.expires_at) return json(200, { ok: false, reason: "expired" });

  // Check script permission
  const perm = await env.DB.prepare(
    "SELECT 1 FROM script_perms WHERE license_id = ? AND script_id = ?"
  ).bind(license.id, script).first();

  if (!perm) return json(200, { ok: false, reason: "no_permission" });

  // Get source
  const scriptRow = await env.DB.prepare(
    "SELECT code FROM scripts WHERE script_id = ?"
  ).bind(script).first();

  if (!scriptRow) return json(200, { ok: false, reason: "script_not_found" });

  // Encrypt: XOR(source, udid + nonce + iv)
  const iv = randomHex(32);
  const cipherKey = udid + nonce + iv;
  const sourceBytes = new TextEncoder().encode(scriptRow.code);
  const encrypted = xorEncrypt(sourceBytes, cipherKey);
  const payloadHex = bytesToHex(encrypted);

  const daysLeft = Math.floor((license.expires_at - now) / 86400);

  // Log access
  await env.DB.prepare(
    "INSERT INTO access_logs (license_id, script_id, ip, udid, ts) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    license.id, script,
    request.headers.get("CF-Connecting-IP") || "unknown",
    udid, now
  ).run();

  return json(200, {
    ok: true,
    payload: payloadHex,
    iv: iv,
    days_left: daysLeft,
    expires_at: license.expires_at,
  });
}

// ═══════════════════════════════════════════
// DEVICE: GET LICENSE INFO + FEATURES
// ═══════════════════════════════════════════

async function handleLicenseInfo(request, env) {
  const body = await request.json();
  const { key, udid } = body;
  if (!key || !udid) return json(400, { ok: false, reason: "missing_fields" });

  const license = await env.DB.prepare(
    "SELECT * FROM licenses WHERE license_key = ?"
  ).bind(key).first();
  if (!license) return json(200, { ok: false, reason: "invalid_key" });
  if (license.revoked) return json(200, { ok: false, reason: "revoked" });
  if (license.udid !== udid) return json(200, { ok: false, reason: "udid_mismatch" });

  const now = Math.floor(Date.now() / 1000);
  if (now > license.expires_at) return json(200, { ok: false, reason: "expired" });

  // Get allowed features (join script_perms with scripts để lấy name)
  const features = await env.DB.prepare(
    `SELECT s.script_id, s.name, s.version
     FROM script_perms p
     JOIN scripts s ON s.script_id = p.script_id
     WHERE p.license_id = ?
     ORDER BY s.name`
  ).bind(license.id).all();

  return json(200, {
    ok: true,
    days_left: Math.floor((license.expires_at - now) / 86400),
    expires_at: license.expires_at,
    customer_name: license.customer_name || "",
    features: features.results || [],
  });
}

// ═══════════════════════════════════════════
// ADMIN: LICENSES
// ═══════════════════════════════════════════

async function handleCreateLicense(request, env) {
  const body = await request.json();
  const { udid, customer_name, customer_contact, plan, days, scripts, note, force } = body;

  if (!udid || !scripts || !Array.isArray(scripts) || scripts.length === 0) {
    return json(400, { ok: false, reason: "missing: udid, scripts[]" });
  }

  // ─── Check 1 device = 1 key (chỉ count active license) ───
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const existing = await env.DB.prepare(
      "SELECT id, license_key, expires_at, revoked FROM licenses WHERE udid = ? AND revoked = 0 AND expires_at > ?"
    ).bind(udid, now).first();
    if (existing) {
      return json(409, {
        ok: false,
        reason: "udid_already_has_key",
        existing_key: existing.license_key,
        existing_id: existing.id,
        message: "Device này đã có license active. Dùng force=true để tạo thêm hoặc xóa key cũ trước.",
      });
    }
  }

  const expiresAt = now + (days || 30) * 86400;
  const licenseKey = generateKey();

  const result = await env.DB.prepare(
    `INSERT INTO licenses (license_key, udid, customer_name, customer_contact, plan, created_at, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(licenseKey, udid, customer_name || "", customer_contact || "", plan || "monthly", now, expiresAt, note || "").run();

  const licenseId = result.meta.last_row_id;

  for (const scriptId of scripts) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO script_perms (license_id, script_id) VALUES (?, ?)"
    ).bind(licenseId, scriptId).run();
  }

  return json(200, {
    ok: true,
    license_key: licenseKey,
    id: licenseId,
    udid,
    expires_at: expiresAt,
    days_left: days || 30,
    scripts,
  });
}

async function handleListLicenses(request, env) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const rows = await env.DB.prepare(
    "SELECT * FROM licenses ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  // Attach script perms
  const now = Math.floor(Date.now() / 1000);
  const licenses = [];
  for (const row of rows.results) {
    const perms = await env.DB.prepare(
      "SELECT script_id FROM script_perms WHERE license_id = ?"
    ).bind(row.id).all();
    licenses.push({
      ...row,
      scripts: perms.results.map(p => p.script_id),
      days_left: Math.max(0, Math.floor((row.expires_at - now) / 86400)),
      status: row.revoked ? "revoked" : (now > row.expires_at ? "expired" : "active"),
    });
  }

  return json(200, { ok: true, licenses, total: rows.results.length });
}

async function handleRevokeLicense(id, env) {
  await env.DB.prepare("UPDATE licenses SET revoked = 1 WHERE id = ?").bind(id).run();
  return json(200, { ok: true, revoked: id });
}

async function handleUnlockLicense(id, env) {
  await env.DB.prepare("UPDATE licenses SET revoked = 0 WHERE id = ?").bind(id).run();
  return json(200, { ok: true, unlocked: id });
}

async function handleDeleteLicense(id, env) {
  // Cleanup: script_perms FK + nullify license_id in access_logs để giữ history
  await env.DB.prepare("DELETE FROM script_perms WHERE license_id = ?").bind(id).run();
  await env.DB.prepare("UPDATE access_logs SET license_id = NULL WHERE license_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(id).run();
  return json(200, { ok: true, deleted: id });
}

async function handleUpdateLicenseScripts(id, request, env) {
  const { scripts } = await request.json();
  if (!Array.isArray(scripts)) {
    return json(400, { ok: false, reason: "scripts must be array" });
  }
  // Replace all permissions
  await env.DB.prepare("DELETE FROM script_perms WHERE license_id = ?").bind(id).run();
  for (const scriptId of scripts) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO script_perms (license_id, script_id) VALUES (?, ?)"
    ).bind(id, scriptId).run();
  }
  return json(200, { ok: true, license_id: id, scripts });
}

// ═══════════════════════════════════════════
// ADMIN: SCRIPTS
// ═══════════════════════════════════════════

async function handleUploadScript(request, env) {
  const body = await request.json();
  const { script_id, name, code, version } = body;

  if (!script_id || !code) {
    return json(400, { ok: false, reason: "missing: script_id, code" });
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO scripts (script_id, name, code, version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(script_id) DO UPDATE SET code=excluded.code, version=excluded.version, updated_at=excluded.updated_at`
  ).bind(script_id, name || script_id, code, version || "1.0.0", now).run();

  return json(200, {
    ok: true,
    script_id,
    version: version || "1.0.0",
    size: code.length,
    updated_at: now,
  });
}

async function handleListScripts(env) {
  const rows = await env.DB.prepare(
    "SELECT script_id, name, version, updated_at, length(code) as size FROM scripts ORDER BY updated_at DESC"
  ).all();
  return json(200, { ok: true, scripts: rows.results });
}

async function handleGetScript_admin(scriptId, env) {
  const row = await env.DB.prepare(
    "SELECT script_id, name, code, version, updated_at FROM scripts WHERE script_id = ?"
  ).bind(scriptId).first();
  if (!row) return json(404, { ok: false, reason: "not_found" });
  return json(200, { ok: true, script: row });
}

async function handleRenameScript(scriptId, request, env) {
  const { name, new_script_id } = await request.json();

  // Đổi tên hiển thị (name) — operation đơn giản
  if (name && !new_script_id) {
    await env.DB.prepare("UPDATE scripts SET name = ? WHERE script_id = ?")
      .bind(name, scriptId).run();
    return json(200, { ok: true, script_id: scriptId, name });
  }

  // Đổi script_id (full rename) — phải update cả permissions
  if (new_script_id && new_script_id !== scriptId) {
    if (!/^[\w-]+$/.test(new_script_id)) {
      return json(400, { ok: false, reason: "invalid_script_id" });
    }
    const exists = await env.DB.prepare("SELECT 1 FROM scripts WHERE script_id = ?")
      .bind(new_script_id).first();
    if (exists) return json(409, { ok: false, reason: "script_id_already_exists" });

    await env.DB.prepare("UPDATE scripts SET script_id = ?, name = COALESCE(?, name) WHERE script_id = ?")
      .bind(new_script_id, name || null, scriptId).run();
    await env.DB.prepare("UPDATE script_perms SET script_id = ? WHERE script_id = ?")
      .bind(new_script_id, scriptId).run();
    return json(200, { ok: true, old_script_id: scriptId, new_script_id, name });
  }

  return json(400, { ok: false, reason: "missing: name or new_script_id" });
}

async function handleDeleteScript(scriptId, env) {
  // Cleanup: script_perms (FK) + scripts
  await env.DB.prepare("DELETE FROM script_perms WHERE script_id = ?").bind(scriptId).run();
  await env.DB.prepare("DELETE FROM scripts WHERE script_id = ?").bind(scriptId).run();
  return json(200, { ok: true, deleted: scriptId });
}

// ═══════════════════════════════════════════
// ADMIN: LOGS
// ═══════════════════════════════════════════

async function handleLogs(request, env) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const rows = await env.DB.prepare(
    `SELECT l.*, lic.license_key, lic.customer_name
     FROM access_logs l
     LEFT JOIN licenses lic ON l.license_id = lic.id
     ORDER BY l.ts DESC LIMIT ?`
  ).bind(limit).all();
  return json(200, { ok: true, logs: rows.results });
}

// ═══════════════════════════════════════════
// PUBLIC: SCRIPT LIST
// ═══════════════════════════════════════════

async function handlePublicScriptList(env) {
  // Only metadata (id, name, version) — never source.
  const rows = await env.DB.prepare(
    "SELECT script_id, name, version FROM scripts ORDER BY name"
  ).all();
  return json(200, { ok: true, scripts: rows.results });
}

// ═══════════════════════════════════════════
// FLEET LICENSING (PokemonFleet desktop app)
// ═══════════════════════════════════════════

/**
 * Verify a PokemonFleet license against fleet_licenses table.
 * Body: { key, machine_id }
 * Returns: { valid, plan, expires_at, max_devices, message }
 *
 * fleet_licenses schema (run as D1 migration before first use):
 *   CREATE TABLE fleet_licenses (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     license_key TEXT UNIQUE NOT NULL,
 *     machine_id TEXT,
 *     plan TEXT NOT NULL DEFAULT 'monthly',
 *     created_at INTEGER NOT NULL,
 *     expires_at INTEGER NOT NULL,
 *     max_devices INTEGER NOT NULL DEFAULT 10,
 *     revoked INTEGER NOT NULL DEFAULT 0,
 *     note TEXT
 *   );
 */
async function handleFleetVerify(request, env) {
  const body = await request.json().catch(() => ({}));
  const { key, machine_id } = body;
  if (!key || !machine_id) {
    return json(400, { valid: false, message: "missing: key, machine_id" });
  }

  let row;
  try {
    row = await env.DB.prepare(
      "SELECT * FROM fleet_licenses WHERE license_key = ?"
    ).bind(key).first();
  } catch (e) {
    // Table missing — return a clear, actionable error so admin knows to migrate.
    return json(200, {
      valid: false,
      message: "fleet_licenses table not found — run D1 migration (see worker.js header)",
    });
  }

  if (!row)         return json(200, { valid: false, message: "invalid key" });
  if (row.revoked)  return json(200, { valid: false, message: "license revoked" });
  const now = Math.floor(Date.now() / 1000);
  if (now > row.expires_at) return json(200, { valid: false, message: "license expired" });

  // First-time activation: bind machine_id.
  if (!row.machine_id) {
    await env.DB.prepare("UPDATE fleet_licenses SET machine_id = ? WHERE id = ?")
      .bind(machine_id, row.id).run();
  } else if (row.machine_id !== machine_id) {
    return json(200, { valid: false, message: "license already bound to another machine" });
  }

  return json(200, {
    valid: true,
    plan: row.plan,
    expires_at: row.expires_at,
    max_devices: row.max_devices,
  });
}

async function handleListFleetLicenses(env) {
  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM fleet_licenses ORDER BY created_at DESC"
    ).all();
    return json(200, { ok: true, licenses: rows.results || [] });
  } catch (e) {
    return json(200, { ok: false, reason: "fleet_licenses_table_missing" });
  }
}

async function handleCreateFleetLicense(request, env) {
  const body = await request.json();
  const { plan, days, max_devices, note } = body;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (parseInt(days) || 30) * 86400;
  const licenseKey = generateKey();
  await env.DB.prepare(
    `INSERT INTO fleet_licenses (license_key, plan, created_at, expires_at, max_devices, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    licenseKey,
    plan || "monthly",
    now,
    expiresAt,
    parseInt(max_devices) || 10,
    note || "",
  ).run();
  return json(200, { ok: true, license_key: licenseKey, expires_at: expiresAt });
}

async function handleRevokeFleetLicense(id, env) {
  await env.DB.prepare("UPDATE fleet_licenses SET revoked = 1 WHERE id = ?").bind(id).run();
  return json(200, { ok: true, revoked: id });
}

// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// PUBLIC: DATA REGISTRY
// ═══════════════════════════════════════════

async function handleDataRegistry(env) {
  const rows = await env.DB.prepare(
    "SELECT script_id, name, data_files FROM scripts ORDER BY name"
  ).all();

  const registry = {};
  for (const s of (rows.results || [])) {
    let files;
    try {
      files = s.data_files ? JSON.parse(s.data_files) : null;
    } catch(e) { files = null; }

    if (!files || files.length === 0) {
      files = [
        { name: "account.txt", desc: "Tài khoản (TK|MK)", editable: true },
        { name: "Success.txt", desc: "Kết quả thành công", editable: false },
        { name: "Failed.txt", desc: "Kết quả lỗi", editable: false },
      ];
    }
    registry[s.script_id] = { label: s.name || s.script_id, files };
  }

  return json(200, { ok: true, registry });
}

// HELPERS
// ═══════════════════════════════════════════

function xorEncrypt(data, key) {
  const keyBytes = new TextEncoder().encode(key);
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length / 2));
  return bytesToHex(bytes);
}

function generateKey() {
  // Format: XXXX-XXXX-XXXX-XXXX (16 chars alphanumeric uppercase)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 confusion
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let key = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += "-";
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

async function checkRateLimit(env, key) {
  const bucket = `rl:${key}`;
  const now = Date.now();
  const raw = await env.KV.get(bucket);
  let timestamps = raw ? JSON.parse(raw) : [];
  timestamps = timestamps.filter(t => now - t < 60000);
  if (timestamps.length >= 30) return true;
  timestamps.push(now);
  await env.KV.put(bucket, JSON.stringify(timestamps), { expirationTtl: 120 });
  return false;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
