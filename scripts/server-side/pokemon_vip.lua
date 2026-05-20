-- ============================================================
-- 🎮 POKEMON VIP — Source script (server-side)
-- ============================================================
-- File này NẰM TRÊN SERVER, KHÔNG distribute cho customer.
-- Customer chỉ có PokemonLoader.lua (fetch + decrypt + run file này).
--
-- CONFIG đến từ loader injection (xem PokemonLoader.lua):
--   CONFIG.MAIL_SERVER_URL
--   CONFIG.MAIL_HEADERS
--   CONFIG.ACCOUNT_FILE
--   CONFIG.SUCCESS_FILE
--   CONFIG.FAILED_FILE
-- ============================================================

-- Fallback nếu CONFIG nil (bắt buộc loader phải inject)
CONFIG = CONFIG or {}
local MAIL_SERVER_URL = CONFIG.MAIL_SERVER or CONFIG.MAIL_SERVER_URL
local MAIL_HEADERS = CONFIG.MAIL_HEADERS or {["ngrok-skip-browser-warning"] = "true"}
local CHANGE_IP = (CONFIG.CHANGE_IP or "false"):lower() == "true"

-- Data folder — tách riêng file của script này khỏi các script khác.
-- App PokemonFleet đọc/ghi file theo đúng thư mục này.
local DATA_DIR = "Chuysen/"
os.execute("mkdir -p " .. DATA_DIR:sub(1, -2))  -- tạo thư mục nếu chưa có

local ACCOUNT_FILE = DATA_DIR .. (CONFIG.ACCOUNT_FILE or "account.txt")
local SUCCESS_FILE = DATA_DIR .. (CONFIG.SUCCESS_FILE or "Success.txt")
local FAILED_FILE  = DATA_DIR .. (CONFIG.FAILED_FILE  or "Failed.txt")

-- Tạo file mẫu nếu chưa tồn tại (để user có thể nhập data trước khi chạy)
local function ensureFile(path, defaultContent)
    local f = io.open(path, "r")
    if f then f:close(); return end
    f = io.open(path, "w")
    if f then f:write(defaultContent or ""); f:close() end
end
ensureFile(ACCOUNT_FILE, "TK|MK\n")
ensureFile(SUCCESS_FILE, "")
ensureFile(FAILED_FILE, "")

if not MAIL_SERVER_URL or MAIL_SERVER_URL == "" then
    error("MAIL_SERVER chưa được cấu hình — vui lòng điền vào Pokemon_Config.txt")
end

local lastOTP = nil  -- baseline OTP đã thấy trong inbox

-- ============================================================
-- MAIL HELPERS
-- ============================================================
function findPokemonOTP(body)
    return body:match("【パスコード】(%d%d%d%d%d%d)")
end

function getLatestOTP(email)
    local url = MAIL_SERVER_URL .. "/api/latest?to=" .. email .. "&format=text"
    local ok, resp = pcall(httpGet, url, MAIL_HEADERS)
    if ok and resp and resp ~= "" then
        local ok2, data = pcall(jsonDecode, resp)
        if ok2 and data and data["body"] then
            local otp = findPokemonOTP(data["body"])
            if otp then
                log("📊 OTP baseline hiện tại: " .. otp)
                return otp
            end
        end
    end
    log("📊 Hòm thư chưa có OTP nào — baseline = nil")
    return nil
end

function getPokemonOTP(email, timeout, interval)
    timeout, interval = timeout or 120, interval or 5
    log("🎮 Chờ OTP Pokemon cho: " .. email)
    log("📊 OTP cũ đã biết: " .. tostring(lastOTP or "(chưa có)"))
    toast("📧 Đang chờ OTP từ mail...", 2)
    for elapsed = 0, timeout - 1, interval do
        if elapsed > 0 then sleep(interval) end
        log("🔄 Check mail OTP... (" .. elapsed .. "s/" .. timeout .. "s)")
        local url = MAIL_SERVER_URL .. "/api/latest?to=" .. email .. "&format=text"
        local ok, resp = pcall(httpGet, url, MAIL_HEADERS)
        if ok and resp and resp ~= "" then
            local ok2, data = pcall(jsonDecode, resp)
            if ok2 and data and data["body"] and not data["error"] then
                local current = findPokemonOTP(data["body"])
                log("📬 OTP inbox: " .. tostring(current) .. " | baseline: " .. tostring(lastOTP or "nil"))
                if current and current ~= lastOTP then
                    log("✅ OTP mới: " .. current)
                    toast("✉️ Nhận OTP: " .. current, 2)
                    lastOTP = current
                    return current
                end
            end
        end
    end
    log("❌ Timeout — không tìm thấy OTP mới")
    return nil
end

-- ============================================================
-- FILE I/O HELPERS
-- ============================================================
function removeLastAccount(filePath)
    local file = io.open(filePath, "r")
    if not file then return end
    local lines = {}
    for line in file:lines() do
        line = line:match("^%s*(.-)%s*$")
        if line ~= "" then table.insert(lines, line) end
    end
    file:close()
    if #lines == 0 then return end
    table.remove(lines)
    local out = io.open(filePath, "w")
    for _, l in ipairs(lines) do out:write(l .. "\n") end
    out:close()
    log("🗑️ Đã xóa acc cuối khỏi " .. ACCOUNT_FILE .. " (còn " .. #lines .. ")")
end

function saveFailed(acc, reason)
    appendFile(FAILED_FILE, acc.rawLine .. "|" .. (reason or "unknown") .. "\n")
    log("❌ Lưu acc lỗi: " .. acc.tk .. " → " .. FAILED_FILE)
end

function saveSuccess(acc)
    appendFile(SUCCESS_FILE, acc.rawLine .. "\n")
    log("✅ Lưu acc thành công: " .. acc.tk .. " → " .. SUCCESS_FILE)
end

function readAccountData(filePath)
    local file = io.open(filePath, "r")
    if not file then
        log("❌ Không mở được file: " .. filePath)
        return nil
    end
    local accounts = {}
    for line in file:lines() do
        line = line:match("^%s*(.-)%s*$")
        if line ~= "" then
            local parts = {}
            for part in line:gmatch("([^|]+)") do table.insert(parts, part) end
            if #parts >= 2 then
                table.insert(accounts, {tk = parts[1], mk = parts[2], rawLine = line})
            end
        end
    end
    file:close()
    if #accounts == 0 then
        log("❌ File rỗng hoặc không có dữ liệu hợp lệ")
        return nil
    end
    log("✅ Đọc được " .. #accounts .. " tài khoản")
    return accounts
end

-- ============================================================
-- SAFARI HELPERS
-- ============================================================
function safeWait(sel, ms, label)
    local r = safari.wait(sel, ms or 10000)
    if r and r.ok then return true end
    log("❌ Wait fail [" .. (label or sel) .. "] — " .. tostring(r and r.reason or "unknown"))
    return false
end

function safeClick(sel, label)
    local r = safari.click(sel)
    if r and r.ok then return true end
    log("⚠ Click warn [" .. (label or sel) .. "] — " .. tostring(r and r.reason or "unknown"))
    return false
end

function safeClickText(text, opts, label)
    local r = safari.clickText(text, opts)
    if r and r.ok then return true end
    log("❌ ClickText fail [" .. (label or text) .. "] — " .. tostring(r and r.reason or "unknown"))
    return false
end

-- ============================================================
-- logIN FLOW
-- ============================================================
function Checklogin()
    for i = 1, 5 do
        swipe(190, 600, 190, 152,1)
        if safari.exists("#authCode") then
            log("✅ Đã ở OTP page (iter " .. i .. ")")
            return true
        end
        safari.clickText("ログイン", {tag = "a", exact = true})
        local a = safari.wait("#authCode", 8000)
        if a and a.ok then
            log("✅ Passed Captcha (iter " .. i .. ")")
            toast("✅ Vượt captcha thành công", 2)
            return true
        end

        log("🔄 Checking Captcha... " .. i .. "/5")
        if i == 1 then toast("🔐 Đang vuợt captcha...", 1) end
        sleep(1)
    end
    return false
end

-- ============================================================
-- MAIN PER-ACCOUNT
-- ============================================================
function Main(acc)
    toast("🎮 Đang chạy: " .. acc.tk, 2)

    -- Đổi IP nếu customer bật option
    if CHANGE_IP then
        log("✈️ Đổi IP (Airplane Mode)...")
        toast("✈️ Đang đổi IP...", 1)
        setAirplaneMode(true, 5)
        while getIP() == "unknown" do
            sleep(1)
        end
        toast("IP mới: " .. getIP(), 2)
        log("🌐 IP mới: " .. tostring(getIP()))
    end

    lastOTP = getLatestOTP(acc.tk)
    log("📊 Baseline OTP: " .. tostring(lastOTP or "(không có)"))

    toast("🧹 Đang xóa dữ liệu Safari...", 1)
    spoof.app("com.apple.mobilesafari")
    appRun("com.apple.mobilesafari")
    sleep(2)

    toast("🌐 Đang mở trang Pokemon...", 2)
    safari.launch("https://www.pokemoncenter-online.com/lottery/apply.html")

    if not safeWait("#email", 20000, "login form") then
        return false, "Login form không load"
    end
    sleep(2)

    toast("✏️ Đang điền thông tin đăng nhập...", 1)
    safari.fill("#email", acc.tk); sleep(0.5)
    safari.fill("#password", acc.mk); sleep(1)

    if not Checklogin() then return false, "FAILED CAPTCHA" end

    local OTP = getPokemonOTP(acc.tk, 60, 3)
    if not OTP then return false, "Không nhận được OTP" end
    log("✅ OTP: " .. OTP)

    safari.fill("#authCode", OTP)
    if not safeClickText("認証する", {tag = "a", exact = true}, "xác nhận OTP") then
        return false, "Không click được nút xác nhận OTP"
    end

    toast("🎯 Đang chọn lottery...", 2)
    local lotteryItem2 = "#main > div.comBox > ul > li:nth-child(2) > div.rBox > dl > dt"
    if not safeWait(lotteryItem2, 15000, "lottery list") then
        return false, "Lottery list không xuất hiện"
    end
    if not safeClick(lotteryItem2, "lottery item 2") then
        return false, "Không click được lottery item 2"
    end
    sleep(0.5)

    -- Radio + L0000000059 + link confirm — fire-and-forget
    safari.click("#main > div.comBox > ul > li:nth-child(1) > div.rBox > dl > dd > div.mailForm.L0000000059 > form > ul.radioList > li > p > label > span")
    sleep(0.3)
    safari.click("#L0000000059")
    sleep(0.3)
    safari.click("#main > div.comBox > ul > li:nth-child(1) > div.rBox > dl > dd > div.mailForm.L0000000059 > form > ul.linkList > li > a")
    sleep(1)
    if not safeWait("#applyBtn", 10000, "applyBtn") then
        return false, "applyBtn không xuất hiện"
    end
    toast("🚀 Đang gửi đơn đăng ký...", 2)
    safari.click("#applyBtn")
    sleep(5)    -- TODO: thêm wait verify confirmation page
    return true, nil
end

-- ============================================================
-- LOOP DRIVER
-- ============================================================
local accPath = "/var/mobile/Library/IOSControl/Scripts/" .. ACCOUNT_FILE

if not readFile(ACCOUNT_FILE) then
    log("📄 File " .. ACCOUNT_FILE .. " chưa tồn tại — đang tạo...")
    writeFile(accPath, "TK|MK\n")
    log("✅ Đã tạo: " .. accPath)
    log("📝 Paste tài khoản vào, sau đó chạy lại loader!")
    return
end

while true do
    local accounts = readAccountData(accPath)
    if not accounts or #accounts == 0 then
        log("🏁 Hết tài khoản — hoàn tất!")
        toast("🏁 Đã chạy hết tài khoản!", 3)
        break
    end
    local acc = accounts[#accounts]
    log("════════════════════════════════════════")
    log("🎮 [" .. #accounts .. " còn lại] " .. acc.tk)
    log("════════════════════════════════════════")
    local ok, failReason = Main(acc)
    removeLastAccount(accPath)
    if ok then
        toast("✅ Đăng ký thành công: " .. acc.tk, 3)
        saveSuccess(acc)
    else
        log("⚠️ Acc " .. acc.tk .. " thất bại: " .. tostring(failReason))
        toast("❌ Lỗi: " .. tostring(failReason), 3)
        saveFailed(acc, failReason)
    end
    sleep(2.5)
end
