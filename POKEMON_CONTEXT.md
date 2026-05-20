# 🎮 POKEIOSControl — PROJECT CONTEXT

> Hệ thống bán bot Pokemon dạng SaaS với cloud-based script delivery, license management, desktop fleet manager, và menu-based feature gating.
> **Status: Production**. Customer thật đang dùng.
>
> - Landing page: https://pokemon.ioscontrol.com
> - Admin panel: https://pokemon.ioscontrol.com/admin
> - Desktop app: POKEIOSControl (Tauri 2, Windows + macOS)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     CUSTOMER iPhone (jailbroken)                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  IOSControl tweak (v1.7.2 từ Sileo)                         │  │
│  │   ├── Lua engine + getUDID() + customMenu()                 │  │
│  │   └── HTTP server local                                      │  │
│  │                                                              │  │
│  │  PokemonLoader.lue (single file, encrypted, ship cho mọi    │  │
│  │  customer giống nhau)                                        │  │
│  │   ├── Đọc Pokemon_Config.txt (LICENSE_KEY + MAIL_SERVER)   │  │
│  │   ├── Lấy UDID 40-char từ MobileGestalt                     │  │
│  │   ├── Fetch /api/license/info → features[]                  │  │
│  │   ├── customMenu() chọn feature                              │  │
│  │   └── Fetch /api/script/get → decrypt → run                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              CLOUDFLARE pokemon.ioscontrol.com                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Worker (src/worker.js)                                      │  │
│  │   ├── / (root)                 ← landing.html (commercial)   │  │
│  │   ├── /admin                   ← admin.html (Pokemon theme)  │  │
│  │   ├── /api/license/info        ← loader: lấy features       │  │
│  │   ├── /api/script/get          ← loader: lấy script (encr)   │  │
│  │   ├── /api/scripts/data-registry ← file manifest per script  │  │
│  │   └── /admin/* (Bearer token)  ← admin panel CRUD            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  D1 Database (pokemon-scripts)                               │  │
│  │   ├── licenses (id, key, udid, customer, expires, revoked)  │  │
│  │   ├── scripts (script_id, name, code, version)               │  │
│  │   ├── script_perms (license_id ↔ script_id)                  │  │
│  │   └── access_logs (audit trail)                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  KV (pokemon-script-rate-limit) — IP-based rate limiting    │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│           POKEIOSControl Desktop App (Tauri 2)                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  PokemonFleet/                                               │  │
│  │   ├── ui/ (Vanilla JS, Pokemon theme, Nunito font)           │  │
│  │   │   ├── index.html          ← main device table            │  │
│  │   │   ├── data-manager.html   ← standalone (unused)          │  │
│  │   │   └── js/components/                                     │  │
│  │   │       ├── DataManager.js  ← fullscreen modal, accordion  │  │
│  │   │       ├── ScreenView.js   ← noVNC viewer                 │  │
│  │   │       ├── ConfigDialog.js ← KEY + MAIL only              │  │
│  │   │       └── ScriptPicker.js ← Fast Run mode                │  │
│  │   └── src-tauri/ (Rust backend)                              │  │
│  │       ├── device/api.rs       ← HTTP client to iPhone        │  │
│  │       ├── device/watcher.rs   ← USB device detection          │  │
│  │       └── fleet/commands.rs   ← Tauri commands                │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
FakeIphone/
├── pokemon-worker/                    ⭐ Cloudflare Worker
│   ├── wrangler.toml                   # Config (D1 + KV + custom domain)
│   ├── schema.sql                      # D1 schema
│   └── src/
│       ├── worker.js                   # Main API + routing (/ → landing, /admin → admin)
│       ├── landing.html                # Commercial landing page (POKEIOSControl)
│       └── admin.html                  # Admin panel (Pokemon theme, Nunito font)
│
├── PokemonFleet/                      ⭐ Desktop App (Tauri 2)
│   ├── package.json                    # npm run dev / npm run tauri build
│   ├── ui/                             # Frontend (Vanilla JS)
│   │   ├── index.html                  # Main device table
│   │   ├── data-manager.html           # Standalone page (reference)
│   │   ├── screen-grid.html            # Multi-screen viewer
│   │   ├── styles/main.css             # All styles (Pokemon theme)
│   │   └── js/
│   │       ├── app.js                  # Main controller
│   │       ├── api.js                  # Tauri invoke wrappers
│   │       └── components/
│   │           ├── DataManager.js      # Fullscreen modal, accordion folders, table view
│   │           ├── ConfigDialog.js     # KEY + MAIL_SERVER only
│   │           ├── ScriptPicker.js     # Fast Run mode
│   │           ├── ScreenView.js       # noVNC single device
│   │           └── ScreenGridView.js   # Multi-device grid
│   └── src-tauri/                      # Rust backend
│       ├── tauri.conf.json
│       ├── capabilities/default.json   # Permissions (main, screen-grid, data-manager)
│       └── src/
│           ├── device/api.rs           # HTTP client → iPhone IOSControl API
│           ├── device/watcher.rs       # USB device detection (idevice_id)
│           ├── device/tunnel.rs        # iproxy tunnel management
│           └── fleet/commands.rs       # Tauri commands (read_file, write_file, etc.)
│
├── scripts/                           ⭐ Lua scripts
│   ├── PokemonLoader.lua               # Source loader (encrypt → .lue ship)
│   ├── PokemonLoader.lue               # Encrypted final, ship cho customer
│   ├── HUONG_DAN.txt                   # Hướng dẫn customer install
│   ├── server-side/
│   │   ├── pokemon_vip.lua             # Bot logic (v1.2.0, writes to Chuysen/ subfolder)
│   │   └── README.md
│   └── tools/
│       └── ic_encrypt.py               # AES-256-CBC + HMAC encryptor (.lua → .lue)
│
└── IOSControl/                        # Tweak (Sileo deploy)
    └── src/
        ├── LuaEngine.m                 # Lua API: getUDID, customMenu, dialogChoice
        └── HTTPServer.m                # Local HTTP server + /api/scripts/* file I/O
```

---

## 3. Production Endpoints

| URL                                                        | Purpose                            |
| ---------------------------------------------------------- | ---------------------------------- |
| `https://pokemon.ioscontrol.com`                           | Landing page (commercial, pricing) |
| `https://pokemon.ioscontrol.com/admin`                     | Admin panel (Pokemon theme)        |
| `https://pokemon.ioscontrol.com/api/license/info`          | Loader: get features               |
| `https://pokemon.ioscontrol.com/api/script/get`            | Loader: fetch encrypted script     |
| `https://pokemon.ioscontrol.com/api/scripts/data-registry` | Data file manifest per script      |
| `https://pokemon.ioscontrol.com/admin/*`                   | Admin CRUD (Bearer token)          |

**Admin token**: `Trieu@123` (env var `ADMIN_TOKEN` trong wrangler.toml)
**D1 ID**: `acf9b243-ff9f-474f-9c79-f5d58a3d133b`
**KV ID**: `595ee614147e4043840e048ed5ea19b0`
**Contact**: @IOSControl_Recap1s (Telegram)

---

## 4. Database Schema

### `licenses`

```sql
id              INTEGER PRIMARY KEY
license_key     TEXT UNIQUE         -- format: ABCD-EFGH-IJKL-MNOP
udid            TEXT                -- 40-char UDID (MobileGestalt)
customer_name   TEXT
customer_contact TEXT               -- zalo/telegram/email
plan            TEXT                -- 'monthly', 'yearly'
created_at      INTEGER (unix)
expires_at      INTEGER (unix)
revoked         INTEGER (0/1)       -- 1 = locked
note            TEXT                -- internal note
```

### `scripts`

```sql
script_id   TEXT PRIMARY KEY    -- vd: 'pokemon_vip', 'buychusen'
name        TEXT                -- display name
code        TEXT                -- raw Lua source
version     TEXT                -- '1.0.0' (auto-bump on save)
updated_at  INTEGER
```

### `script_perms` (M:N)

```sql
license_id  INTEGER → licenses(id)
script_id   TEXT → scripts(script_id)
```

1 license có thể được cấp quyền nhiều scripts. Customer chỉ thấy & chạy được scripts trong bảng này.

### `access_logs`

```sql
id, license_id, script_id, ip, udid, ts
```

Lưu mỗi request `/api/script/get` → audit + abuse detection.

---

## 5. Security Pipeline

### License → Script delivery

```
Customer device                      Server                       D1
    │                                  │                           │
    │ POST /api/license/info           │                           │
    │ { key, udid }                    │                           │
    ├─────────────────────────────────►│                           │
    │                                  │ SELECT licenses WHERE key  │
    │                                  ├──────────────────────────►│
    │                                  │ Verify: revoked, expires,  │
    │                                  │         udid match         │
    │                                  │ JOIN script_perms → scripts│
    │ { ok, days_left, features[] }   │                           │
    │◄─────────────────────────────────│                           │
    │                                  │                           │
    │ User chọn feature qua customMenu │                           │
    │                                  │                           │
    │ POST /api/script/get             │                           │
    │ { key, udid, script,             │                           │
    │   nonce(32-hex),                 │                           │
    │   loader_version }               │                           │
    ├─────────────────────────────────►│                           │
    │                                  │ Re-verify license + perm   │
    │                                  │ Generate IV (16 bytes)     │
    │                                  │ cipherKey = udid+nonce+IV  │
    │                                  │ payload = XOR(code, key)   │
    │ { ok, payload, iv, days_left }  │                           │
    │◄─────────────────────────────────│                           │
    │                                  │                           │
    │ raw = hexDecode(payload)         │                           │
    │ code = XOR(raw, udid+nonce+iv)   │                           │
    │ load(code, env={CONFIG=...})()    │                           │
```

### Encryption layers

1. **`.lue` format**: AES-256-CBC + HMAC-SHA256 (PokemonLoader.lue trên device)
2. **Script delivery**: XOR per-request với key = `UDID + NONCE + IV` (mỗi lần fetch một key mới)
3. **Sanity check**: Decrypted code phải có `function` hoặc `local` (anti-tampering)

### Anti-piracy mechanisms

- 1 device = 1 active key (UDID uniqueness)
- Force flag để admin tạo key mới khi customer đổi máy
- Server-side reject nếu UDID không match
- Memory wipe sau khi load: `code = nil; raw = nil; collectgarbage()`

---

## 6. Loader Flow (PokemonLoader.lua → .lue)

```lua
1. loadOrCreateConfig()
   └── Đọc Pokemon_Config.txt (key=value format)
   └── Validate LICENSE_KEY + MAIL_SERVER
   └── Auto-tạo file mẫu nếu chưa có

2. showMenuAndRun(CONFIG)
   ├── udid = getUDID() or getSN()       -- 40-char UDID hoặc fallback Serial 12-char
   ├── info = getLicenseInfo(CONFIG, udid) -- POST /api/license/info
   │   └── features = info.features      -- [{script_id, name, version}, ...]
   ├── choice = customMenu(title, subtitle, optionNames)
   │   └── Premium picker UI (gradient header, glassmorphism, spring anim)
   └── fetchAndRunScript(CONFIG, udid, scriptId, scriptName)
       ├── nonce = randomHex(32)
       ├── data = POST /api/script/get
       ├── code = XOR(hexDecode(data.payload), udid+nonce+data.iv)
       └── load(code, "=name", "t", env={CONFIG=...})()
```

---

## 7. Admin Panel Features

`https://pokemon.ioscontrol.com` (login với Bearer token `Trieu@123`)

### Sidebar Tabs

- **Dashboard**: số liệu tổng quan (total licenses, active, expired)
- **Tạo Key**: form tạo license mới với checkbox picker chọn scripts
- **Licenses**: bảng có search/filter, mỗi row có:
  - 🛠 Edit scripts (PATCH /admin/licenses/:id/scripts)
  - 🔒 Lock/Unlock (PUT/DELETE /admin/licenses/:id)
  - 🗑 Hard delete (cleanup script_perms + access_logs)
- **Scripts**: card grid với mỗi script
  - Click → mở Monaco editor, edit + Cmd+S → auto bump version
  - 🗑 Delete script
  - ✏ Rename script
- **Logs**: access_logs gần nhất

### API Endpoints (admin)

| Method | Path                          | Purpose                                            |
| ------ | ----------------------------- | -------------------------------------------------- |
| GET    | `/admin/licenses`             | List all                                           |
| POST   | `/admin/licenses`             | Create (body: udid, days, scripts[], note, force?) |
| PUT    | `/admin/licenses/:id`         | Unlock (revoked = 0)                               |
| DELETE | `/admin/licenses/:id`         | Lock (revoked = 1)                                 |
| PATCH  | `/admin/licenses/:id/scripts` | Update scripts perms (body: scripts[])             |
| GET    | `/admin/scripts`              | List scripts                                       |
| POST   | `/admin/scripts`              | Upsert (body: script_id, name, code, version)      |
| PATCH  | `/admin/scripts/:id`          | Rename (body: name)                                |
| DELETE | `/admin/scripts/:id`          | Delete                                             |
| GET    | `/admin/logs?limit=N`         | Access logs                                        |

---

## 8. Customer Flow

```
1. Mua bot → admin tạo key qua web admin
   - Customer cung cấp UDID 40-char (copy từ tab Settings của iControlApp)
   - Admin chọn scripts cấp quyền (vd pokemon_vip + buychusen)
   - Web sinh license_key format ABCD-EFGH-IJKL-MNOP

2. Admin gửi customer:
   - PokemonLoader.lue (file encrypted, single ship cho mọi customer)
   - License key
   - HUONG_DAN.txt

3. Customer cài đặt:
   - Cài IOSControl từ Sileo (https://ioscontrol.com/repo)
   - Copy PokemonLoader.lue vào /var/mobile/Library/IOSControl/Scripts/
   - Run lần đầu → loader tự tạo Pokemon_Config.txt mẫu
   - Mở Pokemon_Config.txt, điền:
     LICENSE_KEY=ABCD-EFGH-IJKL-MNOP
     MAIL_SERVER=https://mail-server-cua-customer.com

4. Customer run PokemonLoader.lue:
   - Loader fetch license info
   - Hiện menu chọn chức năng
   - Decrypt + run script tương ứng
```

---

## 9. Build & Deploy Workflow

### Khi sửa script `pokemon_vip.lua`

```bash
# Cách 1: Web (recommended)
Vào pokemon.ioscontrol.com → Scripts → click pokemon_vip → edit → Cmd+S

# Cách 2: CLI
curl -X POST "https://pokemon.ioscontrol.com/admin/scripts" \
  -H "Authorization: Bearer Trieu@123" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'script_id': 'pokemon_vip',
  'name': 'Pokemon VIP Lottery',
  'code': open('scripts/server-side/pokemon_vip.lua').read(),
  'version': '1.x.x'
}))")"
```

Customer **không cần làm gì** — lần chạy bot tiếp theo sẽ tự nhận source mới.

### Khi sửa loader `PokemonLoader.lua`

```bash
# Re-encrypt
python3 scripts/tools/ic_encrypt.py scripts/PokemonLoader.lua -o scripts/PokemonLoader.lue

# Gửi customer file .lue mới (họ phải replace thủ công)
```

### Khi sửa worker

```bash
cd pokemon-worker
wrangler deploy
```

### Khi sửa IOSControl tweak (vd thêm Lua API mới)

```bash
cd /Users/trieudz/Desktop/FakeIphone
./build_release.sh                          # Build .deb v1.7.2
cd ioscontrol-web && git add -A && git commit && git push  # Sileo repo
```

Customer mở Sileo → Updates → Update IOSControl.

---

## 10. Lua APIs riêng cho ecosystem này

Trong IOSControl tweak (`LuaEngine.m`):

| API                                      | Signature          | Purpose                      |
| ---------------------------------------- | ------------------ | ---------------------------- |
| `getUDID()`                              | → string (40-char) | UDID đồng bộ Settings tab    |
| `getSN()`                                | → string (12-char) | Serial Number (fallback)     |
| `customMenu(title, subtitle, options[])` | → string\|nil      | Premium picker UI            |
| `dialogChoice(title, ...)`               | → string\|nil      | Old UIAlertController picker |
| `httpPost(url, body, headers)`           | → string           | HTTP POST sync               |
| `jsonEncode/jsonDecode`                  | → string/table     | JSON helpers                 |
| `toast(msg, sec)`                        | → void             | Screen toast                 |
| `alert(msg)`                             | → void             | Modal alert                  |

---

## 11. File Lock System (cross-platform)

Lock file `/var/mobile/Library/IOSControl/Scripts/.locked.json`

```json
["PokemonLoader.lue", "Pokemon_Config.txt", "VIPPokemon.lua"]
```

Mọi entry point đọc cùng file:

- **Web IDE** (`http://device:9999/static/connect.html`): icon 🔓/🔒 + badge LOCKED
- **Native iOS app** (iControlApp Files tab): API trả `file_locked` error
- **Quick Panel** (Volume Down ×2): swipe-to-delete bị disable + toast warn
- **API direct**: `/api/scripts/delete` reject với reason

---

## 12. Troubleshooting

### "Key không đúng máy"

- Check UDID device (Settings tab) vs UDID stored in DB
- Old loader dùng `getSN()` (12-char) → re-deploy `.lue` mới (dùng `getUDID()`)

### "Decrypt fail"

- Script quá ngắn không có `function` hoặc `local` → loader sanity check fail
- Solution: thêm `local _DEMO = true` ở đầu script demo

### "Server lỗi" / network timeout

- Check `wrangler deploy` đã success chưa
- Check D1 binding `acf9b243-...` còn link đúng không
- Check rate limit KV (60s window per IP)

### Monaco editor "edit lệch"

- Đã fix với `document.fonts.ready` + `remeasureFonts()`
- Nếu vẫn lệch: hard reload Cmd+Shift+R

---

## 13. Tech Stack Summary

- **Backend**: Cloudflare Workers (JavaScript)
- **Database**: Cloudflare D1 (SQLite-compat)
- **Cache**: Cloudflare KV (rate limit)
- **Desktop App**: Tauri 2 (Rust + Vanilla JS), builds .msi/.exe for Windows
- **Frontend (Web)**: Vanilla HTML/CSS/JS, Nunito + Inter fonts, Pokemon theme
- **Frontend (App)**: Vanilla JS, same Pokemon theme, no build step
- **Encryption**: AES-256-CBC + HMAC-SHA256 (.lue), XOR per-request (delivery)
- **Hosting**: Custom domain `pokemon.ioscontrol.com` qua Cloudflare DNS
- **Tweak**: Theos build → Sileo repo (GitHub Pages)
- **CI/CD**: GitHub Actions (`build-windows.yml`) — blocked by billing

---

## 14. Versioning

| Component          | Current Version         | Notes                        |
| ------------------ | ----------------------- | ---------------------------- |
| IOSControl tweak   | v1.7.2                  | Sileo deploy                 |
| PokemonLoader      | v2.0.0                  | Menu-based, getUDID()        |
| pokemon_vip script | v1.2.0                  | Writes to Chuysen/ subfolder |
| POKEIOSControl app | v0.1.0                  | Tauri 2, Fast Run default on |
| Worker             | Latest commit on `main` | wrangler deploy              |

---

## 15. Data Manager (Desktop App)

Mỗi script ghi file vào subfolder riêng để tránh xung đột:

```
/var/mobile/Library/IOSControl/Scripts/
├── Chuysen/           ← pokemon_vip script
│   ├── account.txt    (editable)
│   ├── Success.txt    (editable)
│   └── Failed.txt     (editable)
├── Register/          ← future script
│   └── ...
└── PokemonLoader.lue
```

**App UI**: Fullscreen modal → accordion sidebar (folders from iPhone) → line-numbered editor + table view toggle.

**API flow**: `listFiles` → filter `type:"folder"` → show folders → `readFile("Chuysen/account.txt")` → edit → `writeFile` → re-pull confirm.

---

## 16. Repos

| Repo                     | Branch                            | Purpose                               |
| ------------------------ | --------------------------------- | ------------------------------------- |
| `trieudz61/PokemonFleet` | `main`                            | Desktop app + worker (public, for CI) |
| `trieudz61/IOSControl`   | `feat/pokemonfleet-windows-build` | Main project (tweak + scripts + app)  |

---

## 17. TODO / Future Hardening

- [ ] Phase 1 hardening: switch `udid` → `fingerprint` hash + custom encryption password
- [ ] Hardcoded admin token → rotate via `wrangler secret put ADMIN_TOKEN`
- [ ] Web admin: add 2FA cho admin token
- [ ] Loader version check (force update nếu cũ)
- [ ] Heartbeat/ping mechanism để detect license sharing
- [ ] Webhook notifications khi license sắp hết hạn (Telegram bot)
- [ ] Resolve GitHub billing → enable CI/CD builds
- [ ] Replace screenshot placeholder in landing page with real app imagery
- [ ] Add pagination to Activity Logs if 50 records insufficient

---

**Last updated**: 2026-05-20
**Maintainer**: trieudz
