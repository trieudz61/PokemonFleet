#!/usr/bin/env python3
"""
Mock script delivery server — for LOCAL testing only.

Mô phỏng API mà Cloudflare Worker production sẽ implement:
  POST /api/script/get  →  trả encrypted source

Run:
  python3 mock_server.py
  # listening :8080

Set up:
  1. Edit LICENSES dict bên dưới với UDID device test của bạn
  2. Place pokemon_vip.lua vào ./scripts/
  3. Trong PokemonLoader.lua, set:
       SCRIPT_SERVER = "http://<MAC_IP>:8080"
       LICENSE_KEY   = "TEST-KEY-001"
"""

import base64
import json
import os
import random
import secrets
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ─────────────────────────────────────────────
# CONFIG (production sẽ ở D1 + Cloudflare KV)
# ─────────────────────────────────────────────
SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "scripts")

LICENSES = {
    # license_key → entry
    "TEST-KEY-001": {
        "udid": "FK3VP4BQJCL6",
        "customer": "test@example.com",
        "expires_at": int(time.time()) + 86400 * 30,  # +30 ngày
        "scripts": ["pokemon_vip"],
        "revoked": False,
    },
}

# Rate limit (per-key requests/minute)
RATE_LIMIT = 30
_rate_buckets = {}   # key → [timestamps]


# ─────────────────────────────────────────────
# CRYPTO — XOR (đơn giản, đủ chống dump source)
# ─────────────────────────────────────────────
def xor_bytes(data: bytes, key: str) -> bytes:
    key_bytes = key.encode("utf-8")
    return bytes(b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(data))


def random_hex(length: int) -> str:
    return secrets.token_hex(length // 2)


# ─────────────────────────────────────────────
# Verify license + script perm
# ─────────────────────────────────────────────
def verify_license(key: str, udid: str, script_id: str):
    entry = LICENSES.get(key)
    if not entry:
        return None, "invalid_key"
    if entry.get("revoked"):
        return None, "revoked"
    if entry["udid"] != udid:
        return None, "udid_mismatch"
    if int(time.time()) > entry["expires_at"]:
        return None, "expired"
    if script_id not in entry.get("scripts", []):
        return None, "no_permission"
    return entry, None


def check_rate_limit(key: str) -> bool:
    now = time.time()
    bucket = _rate_buckets.setdefault(key, [])
    # Drop timestamps > 60s old
    _rate_buckets[key] = [t for t in bucket if now - t < 60]
    if len(_rate_buckets[key]) >= RATE_LIMIT:
        return False
    _rate_buckets[key].append(now)
    return True


# ─────────────────────────────────────────────
# HTTP handler
# ─────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Simpler log
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} - {format % args}")

    def send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/script/get":
            return self.send_json(404, {"ok": False, "reason": "not_found"})

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            req = json.loads(raw)
        except Exception as e:
            return self.send_json(400, {"ok": False, "reason": "bad_request", "detail": str(e)})

        key       = req.get("key", "")
        udid      = req.get("udid", "")
        script_id = req.get("script", "")
        nonce     = req.get("nonce", "")

        if not all([key, udid, script_id, nonce]):
            return self.send_json(400, {"ok": False, "reason": "missing_fields"})

        # Rate limit
        if not check_rate_limit(key):
            print(f"  ⚠ rate limit hit for {key}")
            return self.send_json(429, {"ok": False, "reason": "rate_limit"})

        # Verify
        entry, err = verify_license(key, udid, script_id)
        if err:
            print(f"  ❌ verify fail: {err} (key={key[:12]}... udid={udid[:8]}...)")
            return self.send_json(200, {"ok": False, "reason": err})

        # Load source
        source_path = os.path.join(SCRIPTS_DIR, f"{script_id}.lua")
        if not os.path.isfile(source_path):
            return self.send_json(500, {"ok": False, "reason": "script_not_found"})

        with open(source_path, "rb") as f:
            source_bytes = f.read()

        # Encrypt: XOR(source, udid + nonce + iv)
        iv = random_hex(32)
        cipher_key = udid + nonce + iv
        encrypted = xor_bytes(source_bytes, cipher_key)
        payload_hex = encrypted.hex()  # binary → hex string

        days_left = (entry["expires_at"] - int(time.time())) // 86400

        print(f"  ✅ {key[:12]}... → {script_id} ({len(source_bytes)} bytes)")

        return self.send_json(200, {
            "ok":         True,
            "payload":    payload_hex,
            "iv":         iv,
            "days_left":  days_left,
            "expires_at": entry["expires_at"],
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    port = int(os.environ.get("PORT", "8080"))
    addr = ("0.0.0.0", port)

    if not os.path.isdir(SCRIPTS_DIR):
        os.makedirs(SCRIPTS_DIR)
        print(f"📁 Created scripts dir: {SCRIPTS_DIR}")

    print("═" * 60)
    print(f"🚀 Mock script server listening on :{port}")
    print(f"📂 Scripts dir: {SCRIPTS_DIR}")
    print(f"🔑 Loaded {len(LICENSES)} license(s):")
    for k, v in LICENSES.items():
        days = (v["expires_at"] - int(time.time())) // 86400
        print(f"   • {k}  →  UDID {v['udid'][:14]}... ({days}d, scripts={v['scripts']})")
    print("═" * 60)
    print(f"📡 Test from device:")
    print(f'   curl -X POST http://<MAC_IP>:{port}/api/script/get \\')
    print(f'        -H "Content-Type: application/json" \\')
    print(f'        -d \'{{"key":"TEST-KEY-001","udid":"...","script":"pokemon_vip","nonce":"abc"}}\'')
    print("═" * 60)

    HTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
