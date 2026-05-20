-- ============================================================
-- 🎮 POKEMON LOADER — v1.1
-- ============================================================
-- File này sẽ được encrypt thành PokemonLoader.lue trước khi ship.
-- Customer KHÔNG xem được nội dung này.
--
-- Customer flow:
--   1. Copy PokemonLoader.lue vào /Scripts/
--   2. Run lần đầu → tự tạo file Pokemon_Config.txt
--   3. Mở Pokemon_Config.txt, điền 2 dòng (LICENSE + MAIL_SERVER)
--   4. Run lại → chạy
-- ============================================================

local SCRIPT_SERVER  = "https://pokemon.ioscontrol.com"
local LOADER_VERSION = "2.0.0"
local CONFIG_FILE    = "Pokemon_Config.txt"

-- ============================================================
-- CONFIG TEMPLATE — tạo lần đầu nếu chưa có
-- ============================================================
local CONFIG_TEMPLATE = [[
# ════════════════════════════════════════════════════════════
# 🎮 POKEMON BOT — FILE CẤU HÌNH
# ════════════════════════════════════════════════════════════
# Hướng dẫn:
#   1. Điền LICENSE_KEY admin gửi cho bạn vào dòng dưới
#   2. Điền địa chỉ mail server (admin sẽ hướng dẫn)
#   3. Lưu file lại
#   4. Chạy script
# 
# Lưu ý: KHÔNG xoá dấu = và tên các dòng
# ════════════════════════════════════════════════════════════

LICENSE_KEY=DAN-KEY-VAO-DAY

MAIL_SERVER=https://dia-chi-mail-server.com

# ─── Các dòng bên dưới không cần sửa ─────────────────────────
ACCOUNT_FILE=account.txt
SUCCESS_FILE=Success.txt
FAILED_FILE=Failed.txt
]]

-- ============================================================
-- CONFIG PARSER — đọc file .txt format key=value
-- ============================================================
local function parseConfig(text)
    local cfg = {}
    for line in text:gmatch("[^\r\n]+") do
        -- Bỏ qua comment và dòng trống
        local trimmed = line:match("^%s*(.-)%s*$")
        if trimmed ~= "" and not trimmed:match("^#") then
            local key, value = trimmed:match("^([%w_]+)%s*=%s*(.-)$")
            if key then
                -- Strip dấu nháy nếu có
                value = value:gsub('^["\']', ''):gsub('["\']$', '')
                cfg[key] = value
            end
        end
    end
    return cfg
end

-- ============================================================
-- BOOTSTRAP CONFIG — tự tạo file mẫu nếu chưa có
-- ============================================================
local function loadOrCreateConfig()
    local content = readFile(CONFIG_FILE)

    if not content or content == "" then
        log("📄 Chưa có file cấu hình — đang tạo mẫu...")
        writeFile(CONFIG_FILE, CONFIG_TEMPLATE)
        alert(
            "📋 ĐÃ TẠO FILE CẤU HÌNH\n\n" ..
            "Vui lòng:\n" ..
            "1. Mở file Pokemon_Config.txt\n" ..
            "2. Điền LICENSE_KEY và MAIL_SERVER\n" ..
            "3. Chạy lại script này\n\n" ..
            "File đã được tạo trong thư mục Scripts."
        )
        return nil
    end

    local cfg = parseConfig(content)

    -- Validate required fields
    local missing = {}
    if not cfg.LICENSE_KEY or cfg.LICENSE_KEY == "" or cfg.LICENSE_KEY == "DAN-KEY-VAO-DAY" then
        table.insert(missing, "LICENSE_KEY")
    end
    if not cfg.MAIL_SERVER or cfg.MAIL_SERVER == "" or cfg.MAIL_SERVER:find("dia%-chi%-mail") then
        table.insert(missing, "MAIL_SERVER")
    end

    if #missing > 0 then
        alert(
            "⚠️ THIẾU CẤU HÌNH\n\n" ..
            "Bạn chưa điền:\n• " .. table.concat(missing, "\n• ") .. "\n\n" ..
            "Mở file Pokemon_Config.txt\nđiền đầy đủ rồi chạy lại"
        )
        return nil
    end

    -- Default values
    cfg.ACCOUNT_FILE = cfg.ACCOUNT_FILE or "account.txt"
    cfg.SUCCESS_FILE = cfg.SUCCESS_FILE or "Success.txt"
    cfg.FAILED_FILE  = cfg.FAILED_FILE  or "Failed.txt"

    log("✅ Đã đọc cấu hình:")
    log("   • LICENSE: " .. cfg.LICENSE_KEY:sub(1, 8) .. "...")
    log("   • MAIL:    " .. cfg.MAIL_SERVER)

    return cfg
end

-- ============================================================
-- CRYPTO HELPERS
-- ============================================================
local function xorBytes(data, key)
    local out, kLen = {}, #key
    for i = 1, #data do
        local b = string.byte(data, i)
        local k = string.byte(key, ((i - 1) % kLen) + 1)
        out[i] = string.char(b ~ k)
    end
    return table.concat(out)
end

local function randomHex(len)
    local hex = "0123456789abcdef"
    local out = {}
    for i = 1, len do
        local idx = math.random(1, 16)
        out[i] = string.sub(hex, idx, idx)
    end
    return table.concat(out)
end

-- Hex string → raw bytes
local function hexDecode(s)
    if not s or #s % 2 ~= 0 then return nil end
    local out = {}
    for i = 1, #s, 2 do
        local byte = tonumber(s:sub(i, i + 1), 16)
        if not byte then return nil end
        out[#out + 1] = string.char(byte)
    end
    return table.concat(out)
end

-- ============================================================
-- ERROR MESSAGE MAPPER — tiếng Việt cho customer
-- ============================================================
local ERROR_MESSAGES = {
    invalid_key   = "❌ KEY KHÔNG TỒN TẠI\n\nVui lòng kiểm tra lại key admin gửi.\nLiên hệ admin nếu vẫn lỗi.",
    udid_mismatch = "❌ KEY KHÔNG ĐÚNG MÁY\n\nKey này đăng ký cho máy khác.\nLiên hệ admin để gắn lại key.",
    expired       = "❌ KEY ĐÃ HẾT HẠN\n\nVui lòng gia hạn để tiếp tục sử dụng.",
    revoked       = "❌ KEY ĐÃ BỊ THU HỒI\n\nLiên hệ admin để biết lý do.",
    no_permission = "❌ KEY KHÔNG CÓ QUYỀN\n\nKey này không mua gói Pokemon.\nLiên hệ admin để nâng cấp.",
    rate_limit    = "⏱ TẠM KHOÁ\n\nQuá nhiều request — đợi 1 phút rồi thử lại.",
}

-- ============================================================
-- MAIN: FETCH LICENSE INFO + SHOW MENU + RUN
-- ============================================================
local function getLicenseInfo(CONFIG, udid)
    local reqBody = jsonEncode({ key = CONFIG.LICENSE_KEY, udid = udid })
    local headers = {
        ["Content-Type"] = "application/json",
        ["User-Agent"]   = "PokemonLoader/" .. LOADER_VERSION,
    }
    local ok, resp = pcall(httpPost, SCRIPT_SERVER .. "/api/license/info", reqBody, headers)
    if not ok or not resp or resp == "" then return nil, "network" end
    local okJson, data = pcall(jsonDecode, resp)
    if not okJson or not data then return nil, "bad_response" end
    return data
end

local function fetchAndRunScript(CONFIG, udid, scriptId, scriptName)
    -- Nonce + request
    math.randomseed(os.time() * 1000 + math.floor(os.clock() * 1e6))
    local nonce = randomHex(32)

    local reqBody = jsonEncode({
        key            = CONFIG.LICENSE_KEY,
        udid           = udid,
        script         = scriptId,
        nonce          = nonce,
        loader_version = LOADER_VERSION,
    })
    local headers = {
        ["Content-Type"] = "application/json",
        ["User-Agent"]   = "PokemonLoader/" .. LOADER_VERSION,
    }

    log("📦 Đang tải: " .. scriptName)
    toast("⏳ Đang tải " .. scriptName .. "...", 1)

    local ok, resp = pcall(httpPost, SCRIPT_SERVER .. "/api/script/get", reqBody, headers)
    if not ok or not resp or resp == "" then
        alert("❌ KHÔNG KẾT NỐI ĐƯỢC SERVER\n\nKiểm tra wifi/4G hoặc liên hệ admin")
        return
    end

    local okJson, data = pcall(jsonDecode, resp)
    if not okJson or not data then
        alert("❌ SERVER LỖI\n\nVui lòng thử lại sau ít phút")
        return
    end

    if not data.ok then
        local reason = data.reason or "unknown"
        local msg = ERROR_MESSAGES[reason] or ("❌ Lỗi: " .. reason)
        alert(msg)
        return
    end

    if not data.payload or not data.iv then
        alert("❌ Server response thiếu dữ liệu — báo admin")
        return
    end

    local raw = hexDecode(data.payload)
    if not raw or raw == "" then alert("❌ Decrypt lỗi — báo admin"); return end

    local code = xorBytes(raw, udid .. nonce .. data.iv)
    if not code:find("function") and not code:find("local") then
        alert("❌ Decrypt fail — báo admin\n(Có thể UDID hoặc key sai)")
        return
    end

    -- Compile + run với CONFIG inject
    local env = setmetatable({CONFIG = CONFIG}, {__index = _G})
    local fn, err = load(code, "=" .. scriptId, "t", env)
    code = nil; raw = nil
    collectgarbage("collect"); collectgarbage("collect")

    if not fn then
        alert("❌ Script lỗi parse — báo admin")
        log("Parse error: " .. tostring(err))
        return
    end

    log("🚀 Bắt đầu chạy: " .. scriptName)
    log("════════════════════════════════════════")
    local runOk, runErr = pcall(fn)
    log("════════════════════════════════════════")
    if not runOk then
        log("❌ Lỗi runtime: " .. tostring(runErr))
        alert("❌ SCRIPT BỊ LỖI\n\n" .. tostring(runErr):sub(1, 200))
    else
        log("✅ Script kết thúc bình thường")
    end
end

local function showMenuAndRun(CONFIG)
    -- 1. Get UDID
    local udid = (getUDID and getUDID()) or getSN()
    if not udid or udid == "" then
        alert("❌ KHÔNG LẤY ĐƯỢC UDID\n\nLiên hệ admin để được hỗ trợ.")
        return
    end

    log("🔐 Loader v" .. LOADER_VERSION)
    log("📱 UDID: " .. udid:sub(1, 8) .. "...")
    log("📡 Đang kiểm tra license...")

    -- 2. Fetch license info + features
    local info, errType = getLicenseInfo(CONFIG, udid)
    if not info then
        alert("❌ KHÔNG KẾT NỐI ĐƯỢC SERVER\n\nKiểm tra wifi/4G hoặc liên hệ admin")
        return
    end

    if not info.ok then
        local reason = info.reason or "unknown"
        local msg = ERROR_MESSAGES[reason] or ("❌ Lỗi: " .. reason)
        alert(msg)
        return
    end

    local daysLeft = info.days_left or 0
    if daysLeft <= 3 then
        log("⚠️ Còn " .. daysLeft .. " ngày — gia hạn sớm để không gián đoạn")
    else
        log("✅ License OK — còn " .. daysLeft .. " ngày")
    end

    -- 3. Validate features
    local features = info.features or {}
    if #features == 0 then
        alert("❌ KEY KHÔNG CÓ CHỨC NĂNG NÀO\n\nLiên hệ admin để mua gói.")
        return
    end

    -- 4. Build options list
    local optionNames = {}
    for i, f in ipairs(features) do
        optionNames[i] = (f.name or f.script_id)
    end

    -- 5. Show menu — luôn hiện kể cả khi có 1 chức năng
    local title = "Chọn chức năng"
    local subtitle = "Còn " .. daysLeft .. " ngày · " .. (info.customer_name or "")
    local choice

    if customMenu then
        -- Premium UI (IOSControl >= v1.7.2 với customMenu)
        choice = customMenu(title, subtitle, optionNames)
    else
        -- Fallback (IOSControl cũ)
        choice = dialogChoice(title .. " (còn " .. daysLeft .. " ngày)", table.unpack(optionNames))
    end

    if not choice then
        log("🚫 Người dùng hủy")
        return
    end

    -- Tìm script_id từ tên đã chọn
    local selectedScript = nil
    for _, f in ipairs(features) do
        if (f.name or f.script_id) == choice then
            selectedScript = f
            break
        end
    end

    if not selectedScript then
        alert("❌ Lỗi: không tìm thấy script đã chọn")
        return
    end

    fetchAndRunScript(CONFIG, udid, selectedScript.script_id, selectedScript.name or selectedScript.script_id)
end

-- ============================================================
-- ENTRY POINT
-- ============================================================
log("════════════════════════════════════════")
log("🎮 POKEMON BOT LOADER")
log("════════════════════════════════════════")

local CONFIG = loadOrCreateConfig()
if CONFIG then
    showMenuAndRun(CONFIG)
end
