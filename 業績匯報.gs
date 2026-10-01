/**
 * 羅本家咖哩 信義店｜每日業績自動匯報
 * 週一到週六 14:30（午班小結）、20:30（今日總結）自動抓肚肚後台業績
 * → 寫入「業績回報」分頁（同一天只有一列，晚上會覆蓋午班數字）
 * → 發送 Discord
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   DUDOO_CODE / DUDOO_USERNAME / DUDOO_PASSWORD  肚肚後台登入資料
 *   DISCORD_WEBHOOK                               Discord 頻道 Webhook 網址
 *
 *   RUN_KEY                                       手機一鍵匯報用的密碼（自訂一串英數字）
 *
 * 第一次使用：選擇函式「啟用自動匯報」→ 執行（只要做一次）
 * 手機一鍵匯報：部署為網頁應用程式，用 網址?key=RUN_KEY 開啟
 */

// ===== 設定區 =====
var DUDOO_API    = "https://pos-api.dudooeat.com";
var HIERARCHY_ID = "18116";
var COMPANY_ID   = "13397";
var SHEET_NAME   = "業績回報";
var MONTH_TARGET = 600000;          // 月營業額目標
// 肚肚後台「本月」查詢用的 filterType（在後台選本月時，Network → Payload 裡看到的值）
var MONTH_FILTER_TYPE = "month";
var REPORT_TIMES = ["14:30", "20:30"];
var TZ           = "Asia/Taipei";

// 試算表欄位（順序即欄位順序）
var HEADERS = [
  "日期", "最後更新時間", "總營業額",
  "現金", "LINE Pay", "街口支付", "TWQR", "初茶弁飯", "偷訂", "Foodomo", "樂點外送", "初茶企業",
  "線上營業額", "肚肚線上金流", "UberEats", "foodpanda",
  "其他（未對應）"
];
// 店內收款通路（對應肚肚 transaction）
var STORE_CHANNELS    = ["現金", "LINE Pay", "街口支付", "TWQR", "初茶弁飯", "偷訂", "Foodomo", "樂點外送", "初茶企業"];
// 線上營業額細項（對應肚肚 platform_transaction）
var PLATFORM_CHANNELS = ["肚肚線上金流", "UberEats", "foodpanda"];


// =====================================================
// 1. 啟用 / 停用自動匯報
// =====================================================

/** 只要執行一次：建立每天凌晨的排程器，由它安排當天 14:30、20:30 準時執行 */
function 啟用自動匯報() {
  停用自動匯報();
  ScriptApp.newTrigger("scheduleToday_")
    .timeBased().everyDays(1).atHour(1).inTimezone(TZ).create();
  scheduleToday_(); // 今天剩下的時段也先排好
  Logger.log("✅ 已啟用：週一到週六 " + REPORT_TIMES.join("、") + " 自動匯報");
}

function 停用自動匯報() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === "scheduleToday_" || fn === "runScheduledReport_") ScriptApp.deleteTrigger(t);
  });
  Logger.log("已停用自動匯報");
}

/** 每天凌晨執行：清掉舊的一次性觸發器，週一到週六排入今天的準時觸發器 */
function scheduleToday_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "runScheduledReport_") ScriptApp.deleteTrigger(t);
  });

  var now = new Date();
  var weekday = Number(Utilities.formatDate(now, TZ, "u")); // 1=週一 … 7=週日
  if (weekday === 7) return;

  var today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  REPORT_TIMES.forEach(function(hm) {
    var at = new Date(today + "T" + hm + ":00+08:00");
    if (at.getTime() > now.getTime()) {
      ScriptApp.newTrigger("runScheduledReport_").timeBased().at(at).create();
    }
  });
}

function runScheduledReport_() {
  執行業績匯報();
}


// =====================================================
// 2. 主流程（也可以手動執行測試）
// =====================================================

function 執行業績匯報(titleOverride) {
  var now = new Date();
  var today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  var hour = Number(Utilities.formatDate(now, TZ, "H"));
  var title = (typeof titleOverride === "string" && titleOverride) ? titleOverride
            : (hour < 17 ? "午班小結" : "今日總結");

  try {
    var data = dudooFetch_(today, today, "today");
    var parsed = parseDashboard_(data);
    var sheetMonthTotal = writeSheet_(today, now, parsed);

    // 本月累計：優先向肚肚後台查詢，失敗或數字異常時改用試算表加總
    var monthTotal = sheetMonthTotal, monthSource = "試算表加總";
    try {
      var monthStart = today.substring(0, 8) + "01";
      var monthData = dudooFetch_(monthStart, today, MONTH_FILTER_TYPE);
      var m = Number(monthData.amount || 0);
      if (m >= parsed.values["總營業額"]) { monthTotal = m; monthSource = "肚肚後台"; }
      else Logger.log("本月累計異常（" + m + " < 今日 " + parsed.values["總營業額"] + "），改用試算表加總");
    } catch (e) {
      Logger.log("本月累計查詢失敗，改用試算表加總：" + e);
    }

    sendDiscord_(buildMessage_(title, now, parsed, data, monthTotal, monthSource));
    Logger.log("✅ 匯報完成：" + today + " " + title);
    return { ok: true, total: parsed.values["總營業額"], monthTotal: monthTotal };
  } catch (e) {
    Logger.log("❌ 匯報失敗：" + e);
    try {
      sendDiscord_("⚠️ **羅本家業績匯報失敗**（" + Utilities.formatDate(now, TZ, "M/d HH:mm") + "）\n" + e +
                   "\n請到 Apps Script「執行項目」查看詳細記錄。");
    } catch (e2) {}
    return { ok: false, error: String(e) };
  }
}


// =====================================================
// 手機一鍵匯報（網頁應用程式）
// =====================================================

function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty("RUN_KEY");
  var asJson = e && e.parameter && e.parameter.format === "json";   // 工作台按鈕用
  var json = function(o) {
    return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  };

  if (!key || !e || !e.parameter || e.parameter.key !== key) {
    return asJson ? json({ ok: false, error: "密碼不正確" }) : page_("🔒", "網址不正確", "請使用含有正確 key 的網址開啟。");
  }

  // 工作台首頁即時營業額：只讀取，不寫試算表、不發 Discord
  if (asJson && e.parameter.action === "live") {
    try { return json(getLive_()); }
    catch (err) { return json({ ok: false, error: String(err.message || err) }); }
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return asJson ? json({ ok: false, error: "剛剛已有人按下匯報，請稍後到 Discord 查看" })
                  : page_("⏳", "正在匯報中", "剛剛已有人按下匯報，請稍後到 Discord 查看。");
  }
  try {
    var r = 執行業績匯報("即時業績");
    if (asJson) return json(r);
    if (r.ok) {
      return page_("✅", "已送出到 Discord",
        "今日營業額 NT$" + fmt_(r.total) + "<br>本月累計 NT$" + fmt_(r.monthTotal));
    }
    return page_("⚠️", "匯報失敗", r.error);
  } finally {
    lock.releaseLock();
  }
}

function page_(icon, title, body) {
  var html =
    '<div style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#FDF5E6;min-height:100vh;box-sizing:border-box;">' +
    '<div style="font-size:64px;">' + icon + '</div>' +
    '<h2 style="color:#8B4513;margin:16px 0;">' + title + '</h2>' +
    '<p style="font-size:18px;color:#444;line-height:1.6;">' + body + '</p>' +
    '<p style="font-size:13px;color:#999;margin-top:40px;">' +
    Utilities.formatDate(new Date(), TZ, "M/d HH:mm") + '　羅本家信義店</p></div>';
  return HtmlService.createHtmlOutput(html)
    .setTitle("羅本家業績匯報")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}


// =====================================================
// 3. 肚肚 API
// =====================================================

// ===== 登入憑證快取：減少登入次數，避免把其他裝置的後台登入擠掉 =====
var TOKEN_CACHE_SEC = 6 * 3600;   // 憑證保留 6 小時
var LIVE_CACHE_SEC  = 120;        // 即時營業額 2 分鐘內重複讀取直接用快取

function dudooFetch_(startDate, endDate, filterType) {
  var cache = CacheService.getScriptCache();
  var token = cache.get("dudoo_token");
  if (token) {
    try { return fetchDashboard_(token, startDate, endDate, filterType); }
    catch (e) { cache.remove("dudoo_token"); }   // 憑證過期 → 重新登入
  }
  token = dudooLogin_();
  cache.put("dudoo_token", token, TOKEN_CACHE_SEC);
  return fetchDashboard_(token, startDate, endDate, filterType);
}

function getLive_() {
  var cache = CacheService.getScriptCache();
  var now = new Date();
  var today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  var ck = "live_" + today;
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);

  var d = dudooFetch_(today, today, "today");
  var total = Number(d.amount || 0), persons = Number(d.persons || 0);
  var monthTotal = null;
  try {
    var m = dudooFetch_(today.substring(0, 8) + "01", today, MONTH_FILTER_TYPE);
    monthTotal = Number(m.amount || 0);
    if (monthTotal < total) monthTotal = null;
  } catch (e) {}

  var out = {
    ok: true, total: total, persons: persons, orders: Number(d.sale_cnt || 0),
    avg: persons ? Math.round(total / persons) : 0,
    monthTotal: monthTotal, target: MONTH_TARGET,
    pct: (monthTotal !== null && MONTH_TARGET) ? Math.round(monthTotal / MONTH_TARGET * 1000) / 10 : null,
    updated: now.getTime()
  };
  cache.put(ck, JSON.stringify(out), LIVE_CACHE_SEC);
  return out;
}

function dudooLogin_() {
  var p = PropertiesService.getScriptProperties();
  var code = p.getProperty("DUDOO_CODE"), user = p.getProperty("DUDOO_USERNAME"), pw = p.getProperty("DUDOO_PASSWORD");
  if (!code || !user || !pw) throw new Error("指令碼屬性缺少 DUDOO_CODE / DUDOO_USERNAME / DUDOO_PASSWORD");

  var res = UrlFetchApp.fetch(DUDOO_API + "/auth/login", {
    method: "post",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    headers: { "origin": "https://admin.dudooeat.com" },
    payload: { code: code, username: user, password: pw },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error("肚肚登入失敗（HTTP " + res.getResponseCode() + "）");

  var token = null;
  try { token = findToken_(JSON.parse(res.getContentText())); } catch (e) {}
  if (!token) {
    var h = res.getAllHeaders();
    token = h["access-token"] || h["Access-Token"] || null;
  }
  if (!token) throw new Error("肚肚登入成功但找不到 token，可能是帳密錯誤或後台改版");
  return token;
}

function fetchDashboard_(token, startDate, endDate, filterType) {
  var res = UrlFetchApp.fetch(DUDOO_API + "/statistics/getDashboard?type=reports", {
    method: "post",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    headers: { "access-token": token, "origin": "https://admin.dudooeat.com" },
    payload: {
      filterType: filterType,
      start_date: startDate,
      end_date: endDate,
      hierarchy_id: HIERARCHY_ID,
      company_id: COMPANY_ID
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error("讀取業績失敗（HTTP " + res.getResponseCode() + "）");
  var data = JSON.parse(res.getContentText());
  if (!data.success) throw new Error("肚肚回傳 success=false：" + res.getContentText().substring(0, 200));
  return data;
}

function findToken_(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (var k in obj) {
    if (/token/i.test(k) && typeof obj[k] === "string" && obj[k].length > 10) return obj[k];
    var found = findToken_(obj[k]);
    if (found) return found;
  }
  return null;
}


// =====================================================
// 4. 整理資料
// =====================================================

function norm_(s) { return String(s || "").replace(/\s/g, "").toLowerCase(); }

function parseDashboard_(data) {
  var values = {};
  HEADERS.forEach(function(h) { values[h] = 0; });
  var others = []; // 沒對應到欄位的通路名稱

  var storeMap = {}, platMap = {};
  STORE_CHANNELS.forEach(function(c) { storeMap[norm_(c)] = c; });
  PLATFORM_CHANNELS.forEach(function(c) { platMap[norm_(c)] = c; });

  (data.transaction || []).forEach(function(t) {
    var col = storeMap[norm_(t.name)];
    var amt = Number(t.amount || 0) - Number(t.cancel_amount || 0);
    if (col) values[col] += amt;
    else { values["其他（未對應）"] += amt; others.push(t.name); }
  });

  (data.platform_transaction || []).forEach(function(t) {
    var col = platMap[norm_(t.name)];
    var amt = Number(t.amount || 0) - Number(t.cancel_amount || 0);
    if (col) values[col] += amt;
    else { values["其他（未對應）"] += amt; others.push(t.name); }
    values["線上營業額"] += amt;
  });

  values["總營業額"] = Number(data.amount || 0);
  return { values: values, others: others };
}


// =====================================================
// 5. 寫入試算表（同一天覆蓋同一列），回傳本月累計
// =====================================================

function writeSheet_(today, now, parsed) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#FAF3E8");
    sheet.setFrozenRows(1);
    sheet.getRange("A:A").setNumberFormat("yyyy-mm-dd");
    sheet.getRange("B:B").setNumberFormat("hh:mm");
    sheet.getRange(1, 3, sheet.getMaxRows(), HEADERS.length - 2).setNumberFormat("#,##0");
  }

  var row = [today, now].concat(HEADERS.slice(2).map(function(h) { return parsed.values[h]; }));

  // 找今天的列
  var lastRow = sheet.getLastRow();
  var target = -1;
  if (lastRow >= 2) {
    var dates = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (var i = dates.length - 1; i >= 0; i--) {
      if (dates[i][0] === today) { target = i + 2; break; }
    }
  }
  if (target === -1) target = lastRow + 1;

  sheet.getRange(target, 1, 1, row.length).setValues([row]);
  sheet.getRange(target, 1).setNumberFormat("yyyy-mm-dd");
  sheet.getRange(target, 2).setNumberFormat("hh:mm");
  SpreadsheetApp.flush();

  // 本月累計
  var monthPrefix = today.substring(0, 7);
  var all = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var displayDates = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  var total = 0;
  for (var j = 0; j < all.length; j++) {
    if (displayDates[j][0].indexOf(monthPrefix) === 0) total += Number(all[j][2] || 0);
  }
  return total;
}


// =====================================================
// 6. Discord 訊息
// =====================================================

function fmt_(n) { return Math.round(n).toLocaleString("en-US"); }

function buildMessage_(title, now, parsed, data, monthTotal, monthSource) {
  var v = parsed.values;
  var weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  var d = Utilities.formatDate(now, TZ, "M/d");
  var wd = weekdays[Number(Utilities.formatDate(now, TZ, "u")) % 7];

  var storeTotal = 0, storeLines = [];
  STORE_CHANNELS.forEach(function(c) {
    storeTotal += v[c];
    if (v[c]) storeLines.push("　• " + c + "：" + fmt_(v[c]));
  });
  var platLines = [];
  PLATFORM_CHANNELS.forEach(function(c) {
    if (v[c]) platLines.push("　• " + c + "：" + fmt_(v[c]));
  });

  var persons = Number(data.persons || 0);
  var avg = persons ? v["總營業額"] / persons : 0;
  var pct = MONTH_TARGET ? (monthTotal / MONTH_TARGET * 100).toFixed(1) : "-";

  var msg = "📊 **羅本家信義店｜" + d + "（" + wd + "）" + title + "**　" + Utilities.formatDate(now, TZ, "HH:mm") + "\n" +
            "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n" +
            "💰 營業額：**NT$" + fmt_(v["總營業額"]) + "**\n" +
            "👥 來客數：" + persons + " 人｜客單價：NT$" + fmt_(avg) + "\n\n" +
            "🏪 店內收款：NT$" + fmt_(storeTotal) + "\n" + (storeLines.join("\n") || "　（無）") + "\n\n" +
            "🛵 線上營業額：NT$" + fmt_(v["線上營業額"]) + "\n" + (platLines.join("\n") || "　（無）") + "\n";

  if (v["其他（未對應）"]) {
    msg += "\n⚠️ 未對應通路：" + parsed.others.join("、") + "（NT$" + fmt_(v["其他（未對應）"]) + "），已記在試算表「其他」欄\n";
  }

  msg += "\n📈 本月累計：NT$" + fmt_(monthTotal) + "／目標 NT$" + fmt_(MONTH_TARGET) + "（" + pct + "%）" +
         (monthSource === "肚肚後台" ? "" : "　※" + monthSource) + "\n" +
         "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";
  return msg;
}

function sendDiscord_(message) {
  var url = PropertiesService.getScriptProperties().getProperty("DISCORD_WEBHOOK");
  if (!url) throw new Error("指令碼屬性缺少 DISCORD_WEBHOOK");
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ content: message })
  });
}


/** 測試本月累計：執行後看執行記錄，和肚肚後台「本月」的營業額比對 */
function 測試本月累計() {
  var today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  var data = dudooFetch_(today.substring(0, 8) + "01", today, MONTH_FILTER_TYPE);
  Logger.log("filterType=" + MONTH_FILTER_TYPE + "　本月營業額：" + data.amount +
             "　(chartData.filterType=" + (data.chartData && data.chartData.filterType) + ")");
}
