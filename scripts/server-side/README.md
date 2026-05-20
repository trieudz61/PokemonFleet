# 🎮 Pokemon Cloud Loader — Test Pipeline

Local test environment cho cloud script delivery system trước khi deploy lên Cloudflare Worker production.

## 📂 Cấu trúc

```
scripts/
├── PokemonLoader.lua         ← Customer device (file DUY NHẤT customer thấy)
├── VIPPokemon.lua            ← (legacy, có thể xoá sau khi migrate)
└── server-side/
    ├── mock_server.py        ← Server giả lập, test local
    ├── scripts/
    │   └── pokemon_vip.lua   ← Source bí mật, KHÔNG distribute
    └── README.md             ← File này
```

## 🚀 Setup (10 phút)

### Bước 1: Lấy UDID device test

```bash
# SSH vào device
sshpass -p 'alpine' ssh root@192.168.1.135
# Lấy serial number
gssc | grep SerialNumber
# Hoặc dùng IOSControl Lua:
echo 'log(getSN())' | curl -X POST http://192.168.1.135:9999/api/scripts/run \
  -H "Content-Type: application/json" -d @-
```

Copy UDID 40 ký tự (vd `00008101-001234567890ABCD`).

### Bước 2: Cập nhật mock_server.py

Mở `mock_server.py`, sửa `LICENSES` dict:

```python
LICENSES = {
    "TEST-KEY-001": {
        "udid": "00008101-001234567890ABCD",  # ← UDID của bạn
        "customer": "your@email.com",
        "expires_at": int(time.time()) + 86400 * 30,
        "scripts": ["pokemon_vip"],
        "revoked": False,
    },
}
```

### Bước 3: Đặt source script

Copy `pokemon_vip.lua` vào `server-side/scripts/`:

```bash
mkdir -p server-side/scripts
cp pokemon_vip.lua server-side/scripts/
```

### Bước 4: Chạy mock server

```bash
cd server-side
python3 mock_server.py
```

Output:
```
═══════════════════════════════════════════════════════════
🚀 Mock script server listening on :8080
📂 Scripts dir: /.../server-side/scripts
🔑 Loaded 1 license(s):
   • TEST-KEY-001  →  UDID 00008101-00123... (30d, scripts=['pokemon_vip'])
═══════════════════════════════════════════════════════════
```

### Bước 5: Lấy IP Mac

```bash
ipconfig getifaddr en0    # Wifi
# hoặc
ipconfig getifaddr en1    # Ethernet
```

### Bước 6: Update PokemonLoader.lua

Mở `PokemonLoader.lua`:

```lua
local LICENSE_KEY = "TEST-KEY-001"            -- ← key vừa add vào mock server
-- ...
local SCRIPT_SERVER = "http://192.168.1.20:8080"  -- ← IP Mac của bạn
```

### Bước 7: Push loader lên device

```bash
# Copy file vào IOSControl scripts dir
scp PokemonLoader.lua root@192.168.1.135:/var/jb/var/mobile/Library/IOSControl/Scripts/
```

Hoặc dùng IOSControl Web IDE: paste content + save.

### Bước 8: Run loader trên device

Trong iControlApp → Tab Editor → mở `PokemonLoader.lua` → Run.

## 📋 Expected output

### Loader log
```
🔐 Loader v1.0.0 | UDID=00008101...
📡 Fetching pokemon_vip from server...
✅ License OK — còn 30 ngày
🚀 Running pokemon_vip...
════════════════════════════════════════
📊 Baseline OTP: (không có)
🎮 [3 còn lại] cost_roses4q@icloud.com
...
```

### Mock server log
```
[15:30:15] 192.168.1.135 - "POST /api/script/get HTTP/1.1" 200 -
  ✅ TEST-KEY-001... → pokemon_vip (10756 bytes)
```

## 🐛 Troubleshooting

| Lỗi | Nguyên nhân | Fix |
|---|---|---|
| `❌ Không kết nối server` | Mac IP sai / firewall | Check IP, tắt macOS firewall, ping từ device |
| `❌ License: udid_mismatch` | UDID trong server ≠ device | Update LICENSES dict |
| `❌ License: invalid_key` | Key không có trong dict | Check spelling LICENSE_KEY |
| `❌ License: expired` | expires_at < now | Tăng `+ 86400 * 30` |
| `❌ Decrypt fail — code không hợp lệ` | UDID/nonce/iv mismatch giữa server & loader | Check `getSN()` trả gì, log nó ra |
| `❌ Parse fail` | Source script có syntax error | Test `pokemon_vip.lua` standalone trước |

## 🔐 Security tips

### Test 1: Đổi UDID trên loader
Sửa loader hardcode UDID giả → server phải reject `udid_mismatch`.

### Test 2: Replay attack
Capture request hợp lệ → send lại với cùng nonce → server vẫn trả response (không có nonce store), nhưng decrypt fail trên client vì IV mới mỗi request. **Production**: store nonce trong KV TTL 5 phút.

### Test 3: MITM dump
```bash
mitmdump -p 8888 --mode reverse:http://localhost:8080
# Loader trỏ tới :8888, capture được request nhưng response đã encrypt
```

### Test 4: Source extraction
Sau khi loader load + run, gọi từ Lua script khác:
```lua
collectgarbage("collect")
-- không tìm được string code đâu vì đã GC
```

## 🚢 Production Migration

Khi ready, port mock_server.py → Cloudflare Worker:

1. Tạo D1 database với schema (xem CONTEXT chính)
2. Convert handler logic Python → JS (~200 dòng)
3. Add admin panel HTML → Pages
4. Update `SCRIPT_SERVER` trong loader → URL Worker thật
5. Distribute loader cho customer

## 💡 Pricing template

| Gói | Thời gian | Devices | Update | Giá |
|---|---|---|---|---|
| Trial | 7 ngày | 1 | ❌ | 50K |
| Monthly | 30 ngày | 1 | ✅ | 200K |
| Quarterly | 90 ngày | 1 | ✅ | 500K |
| Yearly | 365 ngày | 1 | ✅ | 1.5M |
| Multi-script | 30 ngày | 1 | ✅ | 500K (3 scripts) |

> [!TIP]
> Giá trị cốt lõi: **Pokemon đổi DOM → bạn fix server-side → customer tự nhận update**.
> Customer KHÔNG cần download file mới.

## 🎯 Next steps

- [ ] Test pipeline local với 1 device thật
- [ ] Setup Cloudflare Worker production
- [ ] Build admin panel (upload script + manage licenses)
- [ ] Migrate VIPPokemon.lua chính thành pokemon_vip.lua server-side
- [ ] Thêm encryption AES nếu XOR không đủ
