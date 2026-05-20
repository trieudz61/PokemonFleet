local FIXED_HOTMAIL = {
    email = "susano7349aea@hotmail.com",
    refresh_token = "M.C558_BAY.0.U.-CtwTFnx4ANJvcmUNV2VXJfhtRKGAB5TA8KRecveBP!2fxNajZmZ3knpdrU*Bh3KqM!BlZNNKHM1yAn3!8ht!UVPJmYII0G95sGt70RwqG5KuVECCK6U*!*03NeGjIXaiaYV6tNvsAWGdu!yUo2SHmBwmLUp!6nfxrFxXUo6SBE1cBz!KdItCt4kRsfwAwsFzaK7imzRmJUh*s!Km7BM5jd3A84NV4E*Sj5LuYguBI26BVnu5MQWUR1n3Ilp94Go*2SItXBkiqI5VhXmdEcN1G*e9H1KvqMiQqgeb45jJzC0dXrzDiSU46w4fyj9Xm87RpuC9s3lufPZrOVWhKT5hOEVuaPaaXMXkw0JJXJ7ffL9zMujfM6ae1HmwV8AJSG4RP8T8lnKtUR7dwfpdLQD0lkI$",
    client_id = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"
}
local VALID_SNS = {
    ["C8PWL61MJC6F"] = true
}
function checkLicense()
    local sn = getSN()
    
    -- Kiểm tra nếu không lấy được SN
    if not sn or sn == "" then
        alert("Lỗi: Không lấy được Serial Number (SN) của thiết bị!")
        lua_exit() -- Lệnh thoát script của AutoTouch/VPhone
        return false
    end

    -- So sánh SN của máy với danh sách hợp lệ
    if VALID_SNS[sn] then
        toast("✅ License hợp lệ. Bắt đầu chạy Tools...")
        return true
    else
        -- Báo lỗi và in ra màn hình SN của thiết bị để copy gửi cho Admin
        alert("❌ License không hợp lệ!\n\nThiết bị chưa được cấp phép.\nSN của máy bạn là: " .. sn .. "\n\nVui lòng cung cấp mã này cho Admin để kích hoạt.")
        return false
    end
end

function Action2()
recordPlay({
  -- Kéo 1: giữ tại chỗ trước khi kéo
  {type=1, x=338.3, y=265.0, time=0.100},
  {type=2, x=338.3, y=265.0, time=0.200},
  {type=2, x=338.3, y=265.0, time=0.300},
  {type=2, x=346.8, y=225.8, time=0.420},
  {type=3, x=355.3, y=186.7, time=0.550},
  -- Kéo 2: (407.7, 126.3) -> (406.9, 178.5)
  {type=1, x=407.7, y=126.3, time=0.800},
  {type=2, x=407.5, y=137.1, time=0.900},
  {type=2, x=406.9, y=178.5, time=1.020},
  -- Kéo 3: (402.8, 466.2) -> (402.0, 552.0)
  {type=1, x=402.8, y=466.2, time=1.400},
  {type=2, x=402.4, y=490.0, time=1.560},
  {type=2, x=402.1, y=520.0, time=1.730},
  {type=3, x=402.0, y=552.0, time=1.900},
})
end
function Action3()    
recordPlay({
  -- Kéo 1: giữ tại chỗ trước khi kéo
  {type=1, x=348.7, y=239.0, time=0.100},
  {type=2, x=348.7, y=239.0, time=0.200},
  {type=2, x=348.7, y=239.0, time=0.300},
  {type=2, x=352.0, y=213.0, time=0.420},
  {type=3, x=357.3, y=186.7, time=0.550},
  -- Kéo 2: (402.0, 113.7) -> (403.0, 168.0)
  {type=1, x=402.0, y=113.7, time=0.800},
  {type=2, x=402.5, y=140.8, time=0.920},
  {type=2, x=403.0, y=168.0, time=1.040},
  -- Kéo 3: (407.8, 443.1) -> (410.0, 580.0)
  {type=1, x=407.8, y=443.1, time=1.400},
  {type=2, x=408.8, y=499.2, time=1.600},
  {type=2, x=409.5, y=560.0, time=1.820},
  {type=2, x=409.8, y=570.0, time=1.920},
  {type=3, x=410.0, y=580.0, time=2.050},
})
end
-- Lấy link Pokemon mới nhất hiện có
function getLatestPokemonLink(account)
    local ok, resp = pcall(httpPost,
        "https://tools.dongvanfb.net/api/get_messages_oauth2",
        jsonEncode({
            email = account.email,
            refresh_token = account.refresh_token,
            client_id = account.client_id,
            list_mail = "all"
        }),
        {["Content-Type"] = "application/json"})
    
    if ok and resp and resp ~= "" then
        local ok2, data = pcall(jsonDecode, resp)
        if ok2 and data and data["status"] == true and data["messages"] then
            for _, msg in ipairs(data["messages"]) do
                local html = (msg["message"] or ""):gsub("&amp;", "&")
                local link = findPokemonLink(html)
                if link then
                    toast("🔗 Link cũ gần nhất: " .. link)
                    return link
                end
            end
        end
    end
    toast("🔗 Chưa có link cũ nào.")
    return nil
end

-- Tìm link từ mail chứa pokemoncenter
function findPokemonLink(html)
    for link in html:gmatch('href="(https?://[^"]+)"') do
        if link:find("pokemoncenter%-online%.com/new%-customer") then return link end
    end
    for link in html:gmatch("(https://www%.pokemoncenter%-online%.com/new%-customer/%?token=[%w%%/+=]+)") do
        return link
    end
    return nil
end

function getPokemonVerifyLink(account, timeout, interval, oldLink)
    timeout, interval = timeout or 30, interval or 3
    toast("🎮 Tìm link Pokemon Center cho: " .. account.email)
    toast("📊 Chờ link mới (link cũ: " .. tostring(oldLink) .. ")...")

    for elapsed = 0, timeout - 1, interval do
        if elapsed > 0 then sleep(interval) end
        toast("🔄 Check mail... (" .. elapsed .. "s/" .. timeout .. "s)")

        local ok, resp = pcall(httpPost,
            "https://tools.dongvanfb.net/api/get_messages_oauth2",
            jsonEncode({
                email = account.email,
                refresh_token = account.refresh_token,
                client_id = account.client_id,
                list_mail = "all"
            }),
            {["Content-Type"] = "application/json"})

        if ok and resp and resp ~= "" then
            local ok2, data = pcall(jsonDecode, resp)
            if ok2 and data and data["status"] == true and data["messages"] then
                local newestLink = nil
                for _, msg in ipairs(data["messages"]) do
                    local html = (msg["message"] or ""):gsub("&amp;", "&")
                    local link = findPokemonLink(html)
                    if link then
                        newestLink = link
                        break -- Lấy link đầu tiên tìm thấy trong danh sách mail mới nhất
                    end
                end
                
                if newestLink and newestLink ~= oldLink then
                    toast("✅ Link mới: " .. newestLink)
                    return newestLink
                end
            end
        end
    end

    toast("❌ Timeout — không tìm thấy link mới")
    return nil
end
function saveAccount(acc)
    local line = acc.email.."|"..acc.ten.."|"..acc.ho.."|"..acc.zipcode.."|"..acc.address1.."|"..acc.address2.."|"..acc.sdt.."|"..acc.password .. "\n"
    appendFile("RegSUCCESS.txt", line)
    toast("💾 Đã lưu tài khoản: " .. acc.email .. " vào RegSUCCESS.txt")
end

function saveFailedAccount(acc)
    local line = acc.email.."|"..acc.ten.."|"..acc.ho.."|"..acc.zipcode.."|"..acc.address1.."|"..acc.address2.."|"..acc.sdt.."|"..acc.password .. "\n"
    appendFile("RegFAIL.txt", line)
    toast("❌ Đã lưu tài khoản lỗi: " .. acc.email .. " vào RegFAIL.txt")
end
function readHotmailData(filePath)
    local file = io.open(filePath, "r")
    if not file then
        toast("❌ Không mở được file: " .. filePath)
        return nil
    end

    local accounts = {}
    for line in file:lines() do
        line = line:match("^%s*(.-)%s*$") -- trim
        if line ~= "" then
            local parts = {}
            for part in line:gmatch("([^|]+)") do
                table.insert(parts, part)
            end
            if #parts >= 7 then
                table.insert(accounts, {
                    email         = parts[1],
                    ten           = parts[2],
                    ho            = parts[3],
                    zipcode       = parts[4],
                    address1      = parts[5],
                    address2      = parts[6],
                    sdt           = parts[7],
                    password      = parts[8]
                })
            end
        end
    end
    file:close()

    if #accounts == 0 then
        toast("❌ File rỗng hoặc không có dữ liệu hợp lệ")
        return nil
    end

    toast("✅ Đọc được " .. #accounts .. " tài khoản Hotmail")
    return accounts
end
function changeIP()
    local maxRetries = 5
    for i = 1, maxRetries do
        toast("✈️ Đang đổi IP... (Lần " .. i .. ")")
        -- Vòng lặp chờ IP
        local waitIPCount = 0
        while waitIPCount < 15 do
            local ip = getIP()
            -- Kiểm tra xem IP lấy được có hợp lệ không
            if ip and ip ~= "unknown" and ip ~= "error" and ip ~= "nil" and ip ~= "0.0.0.0" then
                toast("🌐 Lấy IP thành công: " .. ip)
                return true
            end
            sleep(1)
            waitIPCount = waitIPCount + 1
            toast("⏳ Đang chờ mạng... (" .. waitIPCount .. "s)")
        end
        toast("❌ Không lấy được IP, bật tắt lại máy bay...")
    end
    toast("🚨 Thất bại sau " .. maxRetries .. " lần đổi IP!")
    return false
end

function Main(acc)
    -- Bật tắt máy bay lấy IP trước khi làm
    setAirplaneMode(true, 5)
    appClear("com.apple.mobilesafari")
    if not changeIP() then
        toast("❌ Bỏ qua acc vì lỗi mạng không đổi được IP.")
        return false
    end
    -- Lấy link Pokemon cũ TRƯỚC khi submit
    local accInfo = FIXED_HOTMAIL
    local oldLink = getLatestPokemonLink(accInfo)
    appRun("com.apple.mobilesafari")
    sleep(2)
    openURL("https://www.pokemoncenter-online.com/login")
    --Kiểm tra Trang đã load xong chưa
    tapImage("CheckLoading.png", 30, 1,{4, 158, 174, 166})
    sleep(1)
    swipeUntilImage("InputEmail.png", "up", 10, 1, 0.5)
    sleep(1)
    tapImage("InputEmail.png", 10, 1)
    sleep(1.5)
    local email=acc.email
    inputText(email)
    sleep(0.5)
    tapText("Done", 10, 1,{339, 444, 74, 87})
    sleep(0.5)
    --submit đăng ký
    tapImage("SubmitEmail.png", 10, 1,{112, 348, 188, 168})
    sleep(0.5)
    tapImage("checkStep1.png", 20, 1,{11, 207, 100, 127})
    sleep(0.5)
    swipeUntilImage("SubmitEmail2.png", "up", 10, 1, 1)
    sleep(0.5)
    tapImage("SubmitEmail2.png", 10, 1)
    sleep(0.5)
    local link = getPokemonVerifyLink(accInfo, 30, 3, oldLink)
    if link then openURL(link) end
    ---------------Sau khi mở link
    tapImage("checkStep3.png", 20, 1,{178, 212, 65, 185})
    sleep(0.5)
    local a = 0
    while a < 10 do
        tapImage("12.png", 2, 1,{16, 575, 195, 131})
        sleep(7)
        if  tapImage("next.png", 2, 1) then
            break
        else
           sleep(1)
        end
        a=a+1
    end
    sleep(1) 
    inputText(acc.ten)
    sleep(1)
    tapImage("next.png", 10, 1,{43, 416, 59, 133})
    sleep(1)
    inputText(acc.ho)
    sleep(1)
    tapImage("tempClick.png", 10, 1,{8, 46, 125, 586})
    ------Nhập Ngày Sinh
    sleep(1)
    tapImage("thang.png", 10,1)
    sleep(1)
    tapText("01", 10, 1,{11, 52, 124, 664})
    sleep(1)
    tapImage("ngay.png", 10, 1)
    sleep(1)
    tapText("01", 10, 1,{11, 52, 124, 664})
    sleep(1.5)
    swipe(100, 450, 100, 150, 1)
    sleep(3)
    tapImage("Gioitinh.png", 10, 1,{6, 35, 96, 659})
    sleep(1)
    if randomInt(1, 2)==1 then
        tapImage("Nam.png", 10, 1,{8, 132, 147, 562})
    else
        tapImage("Nu.png", 10, 1,{8, 132, 147, 562})
    end
    sleep(1)
    tapText("0000000", 10, 1,{8, 24, 126, 686})
    sleep(1)
    inputText(acc.zipcode)
    sleep(1)
    inputText(acc.address1)
    sleep(1)
    tapImage("next.png", 10, 1,{43, 416, 59, 133})
    sleep(1)
    inputText(acc.address2)
    sleep(1)
    tapImage("next.png", 10, 1,{43, 416, 59, 133})
    sleep(1)
    inputText(acc.sdt)
    tapImage("next.png", 10, 1,{43, 416, 59, 133})
    sleep(1)
    inputText(acc.password)
    tapImage("next.png", 10, 1,{43, 416, 59, 133})
    sleep(1)
    inputText(acc.password)
    tapText("Done", 10, 1)
    sleep(2)
    tap(200,10)
    sleep(0.5)
    Action3()
    tapImage("Poly1.png", 10, 1,{52, 89, 203, 534})
    sleep(1)
    tapImage("Poly2.png", 10, 1,{52, 89, 203, 534})
    sleep(1)
    tapImage("Submit3.png", 10, 1,{88, 75, 231, 657})
    tapImage("checkStep4.png", 10, 1, {246, 198, 77, 202})
    sleep(1.5)
    Action2()
    sleep(1)
    tapImage("Submit4.png", 10, 1)
    tapImage("checkStep5.png", 30, 1)
    return true
end
-- Xóa dòng cuối cùng trong file hotmail.txt (acc vừa chạy xong)
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
    table.remove(lines) -- xóa dòng cuối
    local out = io.open(filePath, "w")
    for _, l in ipairs(lines) do out:write(l .. "\n") end
    out:close()
    toast("🗑️ Đã xóa acc cuối khỏi hotmail.txt (còn " .. #lines .. " dòng)")
end

-- ============================================
-- CHẠY CHÍNH — Loop từ dưới lên
-- ============================================
checkLicense()
local hotmailFile = "Input.txt"
local hotmailPath = "/var/mobile/Library/IOSControl/Scripts/" .. hotmailFile

local checkData = readFile(hotmailFile)
if not checkData then
    toast("📄 File Input.txt chưa tồn tại — đang tạo file mẫu...")
    writeFile(hotmailFile, "email|ten|Ho|zipcode|address1|address2|sdt|password\n")
    toast("✅ Đã tạo file: " .. hotmailPath)
    toast("📝 Hãy paste dữ liệu vào Input.txt, sau đó chạy lại script!")
    return
end

local accounts = readHotmailData(hotmailPath)
if not accounts or #accounts == 0 then
    toast("🏁 Hết tài khoản hoặc file trống — hoàn tất!")
    return
end

local total = #accounts
for i = total, 1, -1 do
    local acc = accounts[i]
    toast("📧 [" .. i .. "/" .. total .. "] Đang chạy: " .. acc.email)

    local success, ok = pcall(Main, acc)
    removeLastAccount(hotmailPath)

    if not success or not ok then
        toast("⚠️ Acc " .. acc.email .. " thất bại, bỏ qua → tiếp tục")
        saveFailedAccount(acc)
    else
        toast("🎉 Acc " .. acc.email .. " ĐĂNG KÝ THÀNH CÔNG!")
        saveAccount(acc)
    end
end
toast("🏁 Đã chạy xong toàn bộ tài khoản!")












