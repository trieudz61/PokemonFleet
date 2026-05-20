import imaplib
import email
import email.header
import re
import os
import json
import time
import threading
import uuid
import subprocess
import urllib.request
import webbrowser
from datetime import datetime
from flask import Flask, request, jsonify, render_template_string, redirect

import sys

# ============================================================
# CONFIG FILE
# ============================================================
# Khi chạy dưới dạng exe (PyInstaller), lưu config.json cạnh file exe
# Khi chạy .py thường, lưu cạnh server.py
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "imap_host": "imap.mail.me.com",
    "imap_port": 993,
    "imap_user": "",
    "imap_pass": "",
    "max_emails": 500,
    "server_port": 5000,
    "duckdns_subdomain": "",
    "duckdns_token": "",
    "ngrok_token": "",
    "ngrok_domain": "",
}


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
            cfg = DEFAULT_CONFIG.copy()
            cfg.update(saved)
            return cfg
    return DEFAULT_CONFIG.copy()


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


config = load_config()

# ============================================================
# STORAGE
# ============================================================
email_store = {}
store_lock = threading.Lock()
processed_msg_ids = set()
processed_lock = threading.Lock()
imap_status = {"connected": False, "last_error": "", "last_check": ""}
duckdns_status = {"ok": False, "url": "", "last_update": "", "error": ""}
imap_generation = 0  # Increment to kill old IMAP threads

app = Flask(__name__)
app.json.ensure_ascii = False


# ============================================================
# HELPERS
# ============================================================
def safe_print(msg):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode())


def decode_header_value(value):
    if not value:
        return ""
    decoded_parts = email.header.decode_header(value)
    result = []
    for part, charset in decoded_parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or "utf-8", errors="ignore"))
        else:
            result.append(part)
    return " ".join(result)


def extract_email_address(header_value):
    if not header_value:
        return ""
    m = re.search(r"<(.+?)>", header_value)
    if m:
        return m.group(1).strip().lower()
    return header_value.strip().lower()


def extract_all_recipients(msg):
    recipients = []
    to_raw = msg.get("To", "")
    if to_raw:
        for addr in to_raw.split(","):
            email_addr = extract_email_address(addr)
            if email_addr:
                recipients.append(email_addr)
    delivered_to = msg.get("Delivered-To", "")
    if delivered_to:
        addr = extract_email_address(delivered_to)
        if addr and addr not in recipients:
            recipients.append(addr)
    x_original = msg.get("X-Original-To", "")
    if x_original:
        addr = extract_email_address(x_original)
        if addr and addr not in recipients:
            recipients.append(addr)
    return recipients


def get_email_body(msg):
    body_text = ""
    body_html = ""
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            if "attachment" in str(part.get("Content-Disposition", "")):
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                decoded = payload.decode(charset, errors="ignore")
                if content_type == "text/plain":
                    body_text += decoded
                elif content_type == "text/html":
                    body_html += decoded
            except Exception:
                pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                decoded = payload.decode(charset, errors="ignore")
                if msg.get_content_type() == "text/html":
                    body_html = decoded
                else:
                    body_text = decoded
        except Exception:
            pass
    return body_text, body_html


def store_email(msg):
    email_id = str(uuid.uuid4())[:8]
    recipients = extract_all_recipients(msg)
    from_addr = extract_email_address(decode_header_value(msg.get("From", "")))
    subject = decode_header_value(msg.get("Subject", ""))
    date_str = msg.get("Date", "")
    body_text, body_html = get_email_body(msg)

    hide_my_email = ""
    for r in recipients:
        if "privaterelay" in r or "hide" in r:
            hide_my_email = r
            break

    entry = {
        "id": email_id,
        "to": recipients,
        "hide_my_email": hide_my_email if hide_my_email else (recipients[0] if recipients else ""),
        "from": from_addr,
        "subject": subject,
        "date": date_str,
        "body_text": body_text,
        "body_html": body_html,
        "received_at": datetime.now().isoformat(),
    }

    with store_lock:
        email_store[email_id] = entry
        max_emails = config.get("max_emails", 500)
        if len(email_store) > max_emails:
            oldest_key = next(iter(email_store))
            del email_store[oldest_key]

    safe_print(f"[+] id={email_id} | to={recipients} | subject={subject[:50]}")
    return email_id


# ============================================================
# IMAP READER
# ============================================================
def fetch_and_store(mail, max_fetch=50):
    count = 0
    mail.select("INBOX")
    status, response = mail.search(None, "ALL")
    if status != "OK" or not response[0]:
        return 0
    msg_nums = response[0].split()[-max_fetch:]
    for num in msg_nums:
        try:
            _, header_data = mail.fetch(num, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            if header_data[0] is None:
                continue
            msg_id = header_data[0][1].decode(errors="ignore").strip()
            with processed_lock:
                if msg_id in processed_msg_ids:
                    continue
                processed_msg_ids.add(msg_id)
            _, data = mail.fetch(num, "(BODY.PEEK[])")
            if data[0] is None:
                continue
            msg = email.message_from_bytes(data[0][1])
            store_email(msg)
            count += 1
        except Exception as e:
            safe_print(f"[!] Error fetching #{num}: {e}")
    return count


def read_emails(my_gen):
    """Run IMAP reader for this generation. Exits when a newer generation starts."""
    global imap_generation
    first_run = True
    while imap_generation == my_gen:
        if not config.get("imap_user") or not config.get("imap_pass"):
            imap_status["connected"] = False
            imap_status["last_error"] = "IMAP not configured — go to /settings"
            for _ in range(10):
                if imap_generation != my_gen:
                    return
                time.sleep(0.5)
            continue

        mail = None
        try:
            host = config["imap_host"]
            port = config["imap_port"]
            user = config["imap_user"]
            pwd = config["imap_pass"]

            safe_print(f"[*] Connecting to {host}:{port}...")
            mail = imaplib.IMAP4_SSL(host, port, timeout=30)
            safe_print(f"[*] Logging in as {user}...")
            mail.login(user, pwd)
            safe_print("[OK] IMAP connected!")
            imap_status["connected"] = True
            imap_status["last_error"] = ""

            if first_run:
                safe_print("[*] Loading recent emails...")
                count = fetch_and_store(mail, max_fetch=50)
                safe_print(f"[OK] Loaded {count} email(s)")
                first_run = False

            while imap_generation == my_gen:
                try:
                    count = fetch_and_store(mail, max_fetch=20)
                    if count > 0:
                        safe_print(f"[+] {count} new email(s)")
                    imap_status["last_check"] = datetime.now().isoformat()
                    # Sleep in small intervals to detect generation change quickly
                    for _ in range(20):
                        if imap_generation != my_gen:
                            break
                        time.sleep(0.5)
                except imaplib.IMAP4.abort:
                    safe_print("[!] IMAP aborted, reconnecting...")
                    break
                except Exception as e:
                    safe_print(f"[!] Loop error: {e}")
                    break

        except imaplib.IMAP4.error as e:
            err = str(e)
            safe_print(f"[FAIL] Login failed: {err}")
            imap_status["connected"] = False
            imap_status["last_error"] = f"Login failed: {err}"
            for _ in range(60):
                if imap_generation != my_gen:
                    return
                time.sleep(0.5)
        except Exception as e:
            err = str(e)
            safe_print(f"[FAIL] Connection error: {err}")
            imap_status["connected"] = False
            imap_status["last_error"] = f"Connection: {err}"
            for _ in range(20):
                if imap_generation != my_gen:
                    return
                time.sleep(0.5)
        finally:
            if mail:
                try:
                    mail.logout()
                except Exception:
                    pass
    safe_print(f"[IMAP] Thread gen={my_gen} exited (new gen={imap_generation})")


# ============================================================
# DUCKDNS - Auto update IP + save tunnel URL as TXT record
# ============================================================
tunnel_url = ""


def save_tunnel_to_duckdns(tun_url):
    """Save tunnel URL to DuckDNS TXT record so phones can look it up via DNS."""
    subdomain = config.get("duckdns_subdomain", "").strip()
    token = config.get("duckdns_token", "").strip()
    if not subdomain or not token:
        return
    try:
        url = f"https://www.duckdns.org/update?domains={subdomain}&token={token}&txt={tun_url}&verbose=true"
        req = urllib.request.urlopen(url, timeout=10)
        result = req.read().decode().strip()
        if "OK" in result:
            safe_print(f"[DuckDNS] Saved tunnel URL to TXT record")
        else:
            safe_print(f"[DuckDNS] Failed to save TXT: {result}")
    except Exception as e:
        safe_print(f"[DuckDNS] TXT error: {e}")


def update_duckdns():
    """Update DuckDNS IP + TXT every 5 minutes."""
    while True:
        subdomain = config.get("duckdns_subdomain", "").strip()
        token = config.get("duckdns_token", "").strip()
        if subdomain and token:
            try:
                url = f"https://www.duckdns.org/update?domains={subdomain}&token={token}&ip="
                req = urllib.request.urlopen(url, timeout=10)
                result = req.read().decode().strip()
                if result == "OK":
                    duckdns_status["ok"] = True
                    duckdns_status["last_update"] = datetime.now().isoformat()
                    duckdns_status["error"] = ""
                # Also refresh TXT with current tunnel URL
                if tunnel_url:
                    save_tunnel_to_duckdns(tunnel_url)
                    duckdns_status["url"] = tunnel_url
            except Exception as e:
                duckdns_status["ok"] = False
                duckdns_status["error"] = str(e)
        time.sleep(300)


def close_existing_ngrok_tunnels():
    """Close tunnels via running ngrok agent's local REST API. Returns True if any closed."""
    import urllib.request, json
    closed = False
    for api_port in [4040, 4041, 4042]:
        try:
            res = urllib.request.urlopen(f"http://127.0.0.1:{api_port}/api/tunnels", timeout=3)
            data = json.loads(res.read())
            for t in data.get("tunnels", []):
                name = t.get("name", "")
                pub = t.get("public_url", "")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{api_port}/api/tunnels/{name}",
                    method="DELETE"
                )
                try:
                    urllib.request.urlopen(req, timeout=3)
                    safe_print(f"[TUNNEL] Closed via port {api_port}: {pub}")
                    closed = True
                except Exception as de:
                    safe_print(f"[TUNNEL] Delete failed: {de}")
        except Exception:
            pass
    return closed


def start_tunnel(port):
    """Start ngrok tunnel. Auto-recovers from ERR_NGROK_334."""
    global tunnel_url
    token = config.get("ngrok_token", "").strip()
    if not token:
        safe_print("[TUNNEL] No ngrok_token set, skipping tunnel")
        return
    try:
        from pyngrok import ngrok as _ngrok, conf as _conf
        import subprocess as _sp

        # Ẩn cửa sổ đen khi pyngrok spawn ngrok.exe trên Windows
        _OrigPopen = _sp.Popen
        if sys.platform == "win32":
            class _HiddenPopen(_OrigPopen):
                def __init__(self, *a, **kw):
                    kw["creationflags"] = kw.get("creationflags", 0) | 0x08000000  # CREATE_NO_WINDOW
                    super().__init__(*a, **kw)
            _sp.Popen = _HiddenPopen

        try:
            _conf.get_default().auth_token = token
            domain = config.get("ngrok_domain", "").strip()

            for attempt in range(1, 4):
                try:
                    if domain:
                        t = _ngrok.connect(port, "http", domain=domain)
                    else:
                        t = _ngrok.connect(port, "http")
                    tunnel_url = t.public_url.replace("http://", "https://")
                    duckdns_status["url"] = tunnel_url
                    safe_print(f"[TUNNEL] {tunnel_url}")
                    save_tunnel_to_duckdns(tunnel_url)
                    safe_print(f"[TUNNEL] Saved to DuckDNS TXT")
                    return
                except Exception as e:
                    err = str(e)
                    if "ERR_NGROK_334" in err or "already online" in err:
                        safe_print(f"[TUNNEL] ERR_NGROK_334, closing old tunnels (attempt {attempt}/3)...")
                        close_existing_ngrok_tunnels()
                        time.sleep(4)
                    else:
                        safe_print(f"[TUNNEL] Failed: {e}")
                        return
            safe_print("[TUNNEL] Failed after 3 attempts")
        finally:
            _sp.Popen = _OrigPopen  # Restore Popen gốc

    except Exception as e:
        safe_print(f"[TUNNEL] Fatal: {e}")


# ============================================================
# SETTINGS PAGE
# ============================================================
SETTINGS_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>iCloud Mail Server</title>
{% if saved %}<meta http-equiv="refresh" content="4">{% endif %}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 20px; }
  h1 { text-align: center; margin: 24px 0 6px; font-size: 22px; color: #38bdf8; }
  .subtitle { text-align: center; color: #64748b; margin-bottom: 24px; font-size: 13px; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid #334155; }
  .card h2 { color: #38bdf8; font-size: 15px; margin-bottom: 14px; display:flex; align-items:center; gap:6px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 3px; }
  .field input { width: 100%; padding: 9px 11px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 13px; }
  .field input:focus { outline: none; border-color: #38bdf8; }
  .field small { color: #64748b; font-size: 11px; }
  .row { display: flex; gap: 10px; }
  .row .field { flex: 1; }
  .btn { padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; width: 100%; font-weight: 600; }
  .btn:hover { background: #1d4ed8; }
  .status { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .status.ok { background: #064e3b; border: 1px solid #059669; color: #34d399; }
  .status.err { background: #450a0a; border: 1px solid #dc2626; color: #fca5a5; }
  .status.warn { background: #422006; border: 1px solid #d97706; color: #fcd34d; }
  .url-box { background: #0f172a; border: 1px solid #059669; border-radius: 8px; padding: 12px 14px; margin: 8px 0; word-break: break-all; color: #34d399; font-family: monospace; font-size: 14px; font-weight:600; }
  .links { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .links a { color: #38bdf8; text-decoration: none; font-size: 12px; padding: 5px 10px; background: #0f172a; border-radius: 6px; border: 1px solid #334155; }
  .links a:hover { border-color: #38bdf8; }
  .saved { text-align: center; color: #34d399; padding: 8px; margin-top: 8px; font-size: 14px; background: #064e3b; border-radius: 8px; }
  .info { background: #1e293b; border-radius: 8px; padding: 12px; font-size: 12px; color: #94a3b8; }
  .info code { color: #38bdf8; background: #0f172a; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .info p { margin-bottom: 4px; }
  .step { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; margin: 8px 0; font-size: 12px; color: #94a3b8; line-height: 1.7; }
  .step b { color: #38bdf8; }
  .step a { color: #38bdf8; }
  .badge-no { display:inline-block; background:#422006; color:#fcd34d; border-radius:4px; padding:2px 7px; font-size:11px; }
  .badge-ok { display:inline-block; background:#064e3b; color:#34d399; border-radius:4px; padding:2px 7px; font-size:11px; }
</style>
</head>
<body>
<div class="container">
  <h1>☁️ iCloud Mail Server</h1>
  <p class="subtitle">Hide My Email — IMAP Reader API</p>

  {# IMAP status #}
  {% if imap_connected %}
  <div class="status ok">✅ IMAP Connected — {{ imap_user }}</div>
  {% elif imap_error %}
  <div class="status err">❌ IMAP Error: {{ imap_error }}</div>
  {% elif imap_user %}
  <div class="status warn">⏳ IMAP đang kết nối tới {{ imap_user }}...</div>
  {% else %}
  <div class="status warn">⚠️ IMAP chưa được cấu hình</div>
  {% endif %}

  {# Public URL box #}
  {% if tunnel_url %}
  <div class="card">
    <h2>🌐 Public URL (Ngrok)</h2>
    <div class="url-box">{{ tunnel_url }}</div>
    <div class="links">
      <a href="{{ tunnel_url }}/api/emails" target="_blank">/api/emails</a>
      <a href="{{ tunnel_url }}/api/aliases" target="_blank">/api/aliases</a>
      <a href="{{ tunnel_url }}/api/latest?to=xxx" target="_blank">/api/latest</a>
      <a href="{{ tunnel_url }}/api/status" target="_blank">/api/status</a>
    </div>
  </div>
  {% else %}
  <div class="status warn">⚠️ Tunnel chưa kết nối — Kiểm tra Ngrok Token bên dưới</div>
  {% endif %}

  {% if saved %}
  <div class="saved">✅ Đã lưu! IMAP đang kết nối lại...</div>
  {% endif %}

  <form method="POST" action="/settings">

    <div class="card">
      <h2>📧 IMAP Settings</h2>
      <div class="row">
        <div class="field">
          <label>IMAP Host</label>
          <input name="imap_host" value="{{ config.imap_host }}" placeholder="imap.mail.me.com">
        </div>
        <div class="field" style="max-width:90px">
          <label>Port</label>
          <input name="imap_port" type="number" value="{{ config.imap_port }}">
        </div>
      </div>
      <div class="field">
        <label>iCloud Email</label>
        <input name="imap_user" value="{{ config.imap_user }}" placeholder="yourname@icloud.com">
      </div>
      <div class="field">
        <label>App-Specific Password</label>
        <input name="imap_pass" type="password" value="{{ config.imap_pass }}" placeholder="xxxx-xxxx-xxxx-xxxx">
        <small>Tạo tại: appleid.apple.com → Sign-In and Security → App-Specific Passwords</small>
      </div>
    </div>

    <div class="card">
      <h2>🚇 Ngrok Tunnel</h2>
      <div class="step">
        <b>Setup:</b><br>
        1. Đăng ký tại <a href="https://ngrok.com" target="_blank">ngrok.com</a> (miễn phí)<br>
        2. Vào <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank">Your Authtoken</a> → copy token<br>
        3. Vào <a href="https://dashboard.ngrok.com/domains" target="_blank">Domains</a> → <b>New Domain</b> → copy static domain (miễn phí 1 domain)<br>
        4. Nhập vào 2 ô bên dưới → Save → restart server
      </div>
      <div class="field">
        <label>Ngrok Auth Token</label>
        <input name="ngrok_token" type="password" value="{{ config.ngrok_token }}" placeholder="2abc...xyz">
      </div>
      <div class="field">
        <label>Static Domain (tùy chọn)</label>
        <input name="ngrok_domain" value="{{ config.ngrok_domain }}" placeholder="your-name.ngrok-free.dev">
        <small>Để trống nếu muốn dùng URL ngẫu nhiên (đổi mỗi lần restart)</small>
      </div>
    </div>

    <div class="card">
      <h2>⚙️ Server Settings</h2>
      <div class="row">
        <div class="field">
          <label>Max Emails Cache</label>
          <input name="max_emails" type="number" value="{{ config.max_emails }}">
        </div>
        <div class="field">
          <label>Port</label>
          <input name="server_port" type="number" value="{{ config.server_port }}">
        </div>
      </div>
    </div>

    <button type="submit" class="btn">💾 Save Settings</button>
  </form>

  <div class="card" style="margin-top: 16px">
    <h2>📡 API Endpoints</h2>
    <div class="info">
      <p><code>GET /api/status</code> — Trạng thái server</p>
      <p><code>GET /api/emails?to=xxx&limit=50</code> — Danh sách email</p>
      <p><code>GET /api/email/&lt;id&gt;</code> — Chi tiết email</p>
      <p><code>GET /api/latest?to=xxx</code> — Email mới nhất (dùng cho automation)</p>
      <p><code>GET /api/aliases</code> — Danh sách Hide My Email aliases</p>
    </div>
  </div>

  <div class="info" style="margin-top: 12px; text-align: center;">
    Emails cached: {{ email_count }} / {{ config.max_emails }}
  </div>
</div>
</body>
</html>
"""



# ============================================================
# API ENDPOINTS
# ============================================================
@app.route("/", methods=["GET"])
def index():
    return redirect("/settings")


@app.route("/settings", methods=["GET", "POST"])
def settings_page():
    global config, imap_generation
    saved = False
    if request.method == "POST":
        try:
            config["imap_host"] = request.form.get("imap_host", "imap.mail.me.com").strip()
            config["imap_port"] = int(request.form.get("imap_port") or 993)
            config["imap_user"] = request.form.get("imap_user", "").strip()
            config["imap_pass"] = request.form.get("imap_pass", "").strip()
            config["max_emails"] = int(request.form.get("max_emails") or 500)
            config["server_port"] = int(request.form.get("server_port") or 5000)
            old_ngrok_token = config.get("ngrok_token", "")
            old_ngrok_domain = config.get("ngrok_domain", "")
            config["ngrok_token"] = request.form.get("ngrok_token", "").strip()
            config["ngrok_domain"] = request.form.get("ngrok_domain", "").strip()
            save_config(config)
            saved = True

            # Kill old IMAP thread by advancing generation, start new one
            imap_generation += 1
            my_gen = imap_generation
            imap_status["connected"] = False
            imap_status["last_error"] = ""
            with processed_lock:
                processed_msg_ids.clear()
            with store_lock:
                email_store.clear()
            new_imap_t = threading.Thread(target=read_emails, args=(my_gen,), daemon=True)
            new_imap_t.start()

            # Restart tunnel nếu ngrok config thay đổi
            ngrok_changed = (
                config["ngrok_token"] != old_ngrok_token
                or config["ngrok_domain"] != old_ngrok_domain
            )
            if ngrok_changed and config["ngrok_token"]:
                safe_print("[TUNNEL] Ngrok config changed, restarting tunnel...")
                tun_t = threading.Thread(target=start_tunnel, args=(config["server_port"],), daemon=True)
                tun_t.start()

        except ValueError as e:
            imap_status["last_error"] = f"Lỗi lưu cấu hình: {e}"
            safe_print(f"[SETTINGS] ValueError: {e}")

    with store_lock:
        ec = len(email_store)

    return render_template_string(SETTINGS_HTML,
        config=config,
        imap_connected=imap_status["connected"],
        imap_error=imap_status.get("last_error", ""),
        imap_user=config.get("imap_user", ""),
        tunnel_url=tunnel_url,
        saved=saved,
        email_count=ec,
    )



@app.route("/api/emails", methods=["GET"])
def api_get_emails():
    filter_to = request.args.get("to", "").strip().lower()
    filter_from = request.args.get("from", "").strip().lower()
    filter_subject = request.args.get("subject", "").strip().lower()
    limit = int(request.args.get("limit", 50))
    with store_lock:
        results = []
        for eid, entry in reversed(list(email_store.items())):
            if filter_to and filter_to not in entry["to"] and filter_to != entry.get("hide_my_email", ""):
                continue
            if filter_from and filter_from not in entry["from"]:
                continue
            if filter_subject and filter_subject not in entry["subject"].lower():
                continue
            results.append({
                "id": entry["id"], "to": entry["to"], "hide_my_email": entry["hide_my_email"],
                "from": entry["from"], "subject": entry["subject"],
                "date": entry["date"], "received_at": entry["received_at"],
            })
            if len(results) >= limit:
                break
    return jsonify({"count": len(results), "emails": results})


@app.route("/api/email/<email_id>", methods=["GET"])
def api_get_email_detail(email_id):
    fmt = request.args.get("format", "all").strip().lower()
    with store_lock:
        entry = email_store.get(email_id)
    if not entry:
        return jsonify({"error": "Email not found"}), 404
    result = {
        "id": entry["id"], "to": entry["to"], "hide_my_email": entry["hide_my_email"],
        "from": entry["from"], "subject": entry["subject"],
        "date": entry["date"], "received_at": entry["received_at"],
    }
    if fmt == "text":
        result["body"] = entry["body_text"]
    elif fmt == "html":
        result["body"] = entry["body_html"]
    else:
        result["body_text"] = entry["body_text"]
        result["body_html"] = entry["body_html"]
    return jsonify(result)


@app.route("/api/latest", methods=["GET"])
def api_get_latest():
    filter_to = request.args.get("to", "").strip().lower()
    fmt = request.args.get("format", "all").strip().lower()
    if not filter_to:
        return jsonify({"error": "Missing 'to' parameter"}), 400
    with store_lock:
        latest = None
        for eid, entry in reversed(list(email_store.items())):
            if filter_to in entry["to"] or filter_to == entry.get("hide_my_email", ""):
                latest = entry
                break
    if not latest:
        return jsonify({"error": f"No email found for: {filter_to}"}), 404
    result = {
        "id": latest["id"], "to": latest["to"], "hide_my_email": latest["hide_my_email"],
        "from": latest["from"], "subject": latest["subject"],
        "date": latest["date"], "received_at": latest["received_at"],
    }
    if fmt == "text":
        result["body"] = latest["body_text"]
    elif fmt == "html":
        result["body"] = latest["body_html"]
    else:
        result["body_text"] = latest["body_text"]
        result["body_html"] = latest["body_html"]
    return jsonify(result)


@app.route("/api/aliases", methods=["GET"])
def api_get_aliases():
    with store_lock:
        aliases = {}
        for eid, entry in email_store.items():
            alias = entry.get("hide_my_email", "")
            if alias:
                if alias not in aliases:
                    aliases[alias] = {"address": alias, "email_count": 0, "latest_date": ""}
                aliases[alias]["email_count"] += 1
                aliases[alias]["latest_date"] = entry["received_at"]
    return jsonify({"count": len(aliases), "aliases": list(aliases.values())})


@app.route("/api/status", methods=["GET"])
def api_status():
    with store_lock:
        total = len(email_store)
    return jsonify({
        "status": "running",
        "imap_connected": imap_status["connected"],
        "imap_user": config.get("imap_user", ""),
        "total_emails_cached": total,
        "max_cache": config.get("max_emails", 500),
        "tunnel_url": tunnel_url,
        "duckdns_ok": duckdns_status.get("ok", False),
        "last_check": imap_status.get("last_check", ""),
    })


# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    PORT = config.get("server_port", 5000)

    print("=" * 60)
    print("  iCloud Hide My Email - IMAP Reader Server")
    print("=" * 60)
    print(f"  Local   : http://127.0.0.1:{PORT}")
    print(f"  Settings: http://127.0.0.1:{PORT}/settings")
    if config.get("duckdns_subdomain"):
        print(f"  DuckDNS : {config['duckdns_subdomain']}.duckdns.org (TXT = tunnel URL)")
    print("=" * 60)
    print()

    # Start tunnel (localhost.run)
    tun_t = threading.Thread(target=start_tunnel, args=(PORT,), daemon=True)
    tun_t.start()

    # Start DuckDNS updater
    duck_t = threading.Thread(target=update_duckdns, daemon=True)
    duck_t.start()

    # Start IMAP reader
    imap_t = threading.Thread(target=read_emails, args=(imap_generation,), daemon=True)
    imap_t.start()

    # Wait for tunnel to establish
    time.sleep(4)

    # Auto open browser
    threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}/settings")).start()

    # Start API server
    app.run(host="0.0.0.0", port=PORT, use_reloader=False)
