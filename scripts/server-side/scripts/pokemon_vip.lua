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

-- Fallback nếu CONFIG nil (chạy standalone để debug)
CONFIG = CONFIG or {}
-- Customer config field: MAIL_SERVER (format mới key=value)
-- Backward compat: MAIL_SERVER_URL (format cũ)
local MAIL_SERVER_URL = CONFIG.MAIL_SERVER or CONFIG.MAIL_SERVER_URL
    or "https://donut-woven-hurried.ngrok-free.dev"
local MAIL_HEADERS = CONFIG.MAIL_HEADERS or {["ngrok-skip-browser-warning"] = "true"}
local ACCOUNT_FILE = CONFIG.ACCOUNT_FILE or "account.txt"
local SUCCESS_FILE = CONFIG.SUCCESS_FILE or "Success.txt"
local FAILED_FILE = CONFIG.FAILED_FILE or "Failed.txt"

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
-- LOGIN FLOW
-- ============================================================
function CheckLogin()
    for i = 1, 5 do
        if safari.exists("#authCode") then
            log("✅ Đã ở OTP page (iter " .. i .. ")")
            return true
        end
        safari.clickText("ログイン", {tag = "a", exact = true})
        local a = safari.wait("#authCode", 4000)
        if a and a.ok then
            log("✅ Passed Captcha (iter " .. i .. ")")
            return true
        end
        log("🔄 Checking Captcha... " .. i .. "/5")
        sleep(1)
    end
    return false
end

-- ============================================================
-- MAIN PER-ACCOUNT
-- ============================================================
function Main(acc)
    lastOTP = getLatestOTP(acc.tk)
    log("📊 Baseline OTP: " .. tostring(lastOTP or "(không có)"))

    appClear("com.apple.mobilesafari")
    appRun("com.apple.mobilesafari")
    sleep(2)
    safari.launch("https://www.pokemoncenter-online.com/lottery/apply.html")

    if not safeWait("#email", 10000, "login form") then
        return false, "Login form không load"
    end
    sleep(2)

    safari.fill("#email", acc.tk); sleep(0.5)
    safari.fill("#password", acc.mk); sleep(1)

    if not CheckLogin() then return false, "FAILED CAPTCHA" end

    local OTP = getPokemonOTP(acc.tk, 60, 3)
    if not OTP then return false, "Không nhận được OTP" end
    log("✅ OTP: " .. OTP)

    safari.fill("#authCode", OTP)
    if not safeClickText("認証する", {tag = "a", exact = true}, "xác nhận OTP") then
        return false, "Không click được nút xác nhận OTP"
    end

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

    if not safeWait("#applyBtn", 10000, "applyBtn") then
        return false, "applyBtn không xuất hiện"
    end
    safari.click("#applyBtn")
    sleep(3)

    -- TODO: thêm wait verify confirmation page
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
        break
    end
    local acc = accounts[#accounts]
    log("════════════════════════════════════════")
    log("🎮 [" .. #accounts .. " còn lại] " .. acc.tk)
    log("════════════════════════════════════════")
    local ok, failReason = Main(acc)
    removeLastAccount(accPath)
    if ok then
        saveSuccess(acc)
    else
        log("⚠️ Acc " .. acc.tk .. " thất bại: " .. tostring(failReason))
        saveFailed(acc, failReason)
    end
    appClear("com.apple.mobilesafari")
    sleep(2.5)
end
