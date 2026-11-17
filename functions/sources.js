// Each source reads one service and returns plain data for the page.
// They share one Google OAuth token (read-only scopes: Analytics, Play reporting,
// Cloud Storage, AdMob) and never write anywhere.

const PACKAGE = "com.ferwin.blockquest";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const PLAY_API = "https://playdeveloperreporting.googleapis.com/v1beta1";
const ADMOB_API = "https://admob.googleapis.com/v1";

// Keep in step with AnalyticsEvents in the game (Assets/Scripts/Services/IAnalyticsService.cs).
const GAME_EVENTS = [
  "first_open", "session_start", "level_start", "level_complete", "level_fail", "level_continue",
  "world_unlocked", "world_purchased", "shop_view", "shop_purchase", "in_app_purchase",
  "ad_requested", "ad_shown", "ad_reward_granted", "ad_impression", "ad_paid", "ad_slot_missed", "booster_used",
  "daily_reward_claim", "daily_challenge_start", "daily_challenge_complete", "zen_start", "zen_end",
  "win_streak_reward", "review_prompt", "push_setting", "push_prompt", "sign_in_prompt", "run_resume",
  "mission_complete", "mission_claim", "currency_earned", "currency_spent",
  "tutorial_step", "first_piece_placed", "first_line_cleared",
  "promo_shown", "promo_tapped", "event_theme", "event_theme_unlock", "startup_time", "app_remove",
];

const TESTER_DIMENSION = "customUser:tester";
const TESTER_FILTER = { notExpression: { filter: { fieldName: TESTER_DIMENSION, stringFilter: { value: "yes" } } } };

class SourceError extends Error {}

/** fetch with JSON, retrying Google's own 5xx hiccups twice. */
async function call(token, url, body, { raw = false, timeoutMs = 18000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return raw ? res : res.json();
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (raw && res.status === 404) return null;
    let detail = await res.text();
    try { detail = JSON.parse(detail).error.message; } catch { detail = detail.slice(0, 300); }
    throw new SourceError(res.status + " " + detail);
  }
}

// ------------------------------------------------------------ Google Analytics

function rowsOf(data) {
  const dims = (data.dimensionHeaders || []).map((h) => h.name);
  const mets = (data.metricHeaders || []).map((h) => h.name);
  return (data.rows || []).map((row) => {
    const item = {};
    dims.forEach((d, i) => { item[d] = row.dimensionValues[i].value; });
    mets.forEach((m, i) => { const v = Number(row.metricValues[i].value); item[m] = Number.isNaN(v) ? row.metricValues[i].value : v; });
    return item;
  });
}

const range = (days) => [{ startDate: days + "daysAgo", endDate: "yesterday" }];

async function analytics(token, property) {
  const prop = "properties/" + property;
  // Whether testers can be left out: a 400 means the dimension is not registered yet.
  // Asked with a short timeout, so a slow Analytics does not spend the source's whole budget here.
  let excludeTesters = false;
  let testers = null;
  try {
    testers = rowsOf(await call(token, `${DATA_API}/${prop}:runReport`, {
      dateRanges: range(28), dimensions: [{ name: TESTER_DIMENSION }], metrics: [{ name: "activeUsers" }],
    }, { timeoutMs: 6000 }));
    excludeTesters = true;
  } catch { /* not registered, or Analytics is slow: report everyone */ }

  const report = (body) => {
    if (excludeTesters) {
      body = { ...body, dimensionFilter: body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, TESTER_FILTER] } } : TESTER_FILTER };
    }
    return call(token, `${DATA_API}/${prop}:runReport`, body).then(rowsOf);
  };
  const totalsMetrics = ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "purchaseRevenue", "totalAdRevenue", "totalPurchasers"]
    .map((name) => ({ name }));

  // Started with the rest: waiting for it afterwards doubled the source's time.
  const cohorts = retention(report);
  const [daily, last7, prev7, events7, events28, countries, versions] = await Promise.all([
    report({ dateRanges: range(28), dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "userEngagementDuration" }], orderBys: [{ dimension: { dimensionName: "date" } }] }),
    report({ dateRanges: range(7), metrics: totalsMetrics }),
    report({ dateRanges: [{ startDate: "14daysAgo", endDate: "8daysAgo" }], metrics: totalsMetrics }),
    report({ dateRanges: range(7), dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: GAME_EVENTS } } } }),
    report({ dateRanges: range(28), dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: GAME_EVENTS } } } }),
    report({ dateRanges: range(28), dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "userEngagementDuration" }], orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 12 }),
    report({ dateRanges: range(7), dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] }),
  ]);

  return {
    property, excludeTesters, testers,
    totals: { last7: last7[0] || {}, prev7: prev7[0] || {} },
    daily, countries, versions,
    events: Object.fromEntries(events28.map((e) => [e.eventName, {
      count28: e.eventCount, users28: e.totalUsers,
      count7: (events7.find((x) => x.eventName === e.eventName) || {}).eventCount || 0,
      users7: (events7.find((x) => x.eventName === e.eventName) || {}).totalUsers || 0,
    }])),
    retention: await cohorts,
  };
}

/** Daily install cohorts and the share still active on day 1 and day 7. */
async function retention(report) {
  const today = new Date();
  const days = [];
  for (let i = 2; i < 40; i++) days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  const chunks = [];
  for (let i = 0; i < days.length; i += 10) chunks.push(days.slice(i, i + 10));
  const rows = (await Promise.all(chunks.map((chunk) => report({
    dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }],
    metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
    cohortSpec: {
      cohorts: chunk.map((d) => ({ name: d.replaceAll("-", ""), dimension: "firstSessionDate", dateRange: { startDate: d, endDate: d } })),
      cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 7 },
    },
  })))).flat();

  const by = {};
  for (const r of rows) {
    const c = (by[r.cohort] ||= { size: 0, active: {} });
    c.size = Math.max(c.size, r.cohortTotalUsers);
    c.active[Number(r.cohortNthDay)] = r.cohortActiveUsers;
  }
  const rate = (n) => {
    let size = 0, active = 0;
    for (const [name, c] of Object.entries(by)) {
      const age = (today - new Date(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6)}`)) / 86400000;
      if (age <= n || !c.size) continue;
      size += c.size;
      active += c.active[n] || 0;
    }
    return { rate: size ? active / size : null, users: size };
  };
  return { d1: rate(1), d7: rate(7) };
}

async function realtime(token, property) {
  const prop = "properties/" + property;
  const rt = (body) => call(token, `${DATA_API}/${prop}:runRealtimeReport`, body).then(rowsOf);
  const [now, countries, events] = await Promise.all([
    rt({ metrics: [{ name: "activeUsers" }] }),
    rt({ dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], limit: 8 }),
    rt({ dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }],
         dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["first_open", "level_complete", "level_fail", "ad_impression", "in_app_purchase", "app_remove"] } } } }),
  ]);
  return {
    activeUsers: (now[0] || {}).activeUsers || 0,
    countries,
    events: Object.fromEntries(events.map((e) => [e.eventName, e.eventCount])),
  };
}

// ------------------------------------------------------------ Google Play

const playDate = (d) => ({ year: d.year, month: d.month, day: d.day, timeZone: { id: "America/Los_Angeles" } });

async function vital(token, metricSet, metrics) {
  const base = `${PLAY_API}/apps/${PACKAGE}/${metricSet}`;
  const info = await call(token, base);
  const latest = ((info.freshnessInfo || {}).freshnesses || []).find((f) => f.aggregationPeriod === "DAILY");
  if (!latest) return [];
  const end = latest.latestEndTime;
  const start = new Date(Date.UTC(end.year, end.month - 1, end.day) - 28 * 86400000);
  const body = {
    timelineSpec: { aggregationPeriod: "DAILY", startTime: playDate({ year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() }), endTime: playDate(end) },
    metrics, pageSize: 100,
  };
  const rows = (await call(token, base + ":query", body)).rows || [];
  return rows.map((r) => {
    const s = r.startTime;
    const item = { date: `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}` };
    for (const m of r.metrics || []) item[m.metric] = m.decimalValue ? Number(m.decimalValue.value) : null;
    return item;
  });
}

async function playVitals(token) {
  const [crash, anr] = await Promise.all([
    vital(token, "crashRateMetricSet", ["crashRate", "userPerceivedCrashRate", "distinctUsers"]),
    vital(token, "anrRateMetricSet", ["anrRate", "userPerceivedAnrRate", "distinctUsers"]),
  ]);
  return { crash, anr };
}

/** One Play Console report CSV from the reports bucket, or null if Play has not written it. */
async function playCsv(token, bucket, name) {
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await call(token, url, undefined, { raw: true });
  if (!res) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // Play writes UTF-16 with a byte order mark.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString("utf16le") : buf.toString("utf8").replace(/^﻿/, "");
  return parseCsv(text);
}

/** RFC 4180: a quoted field may hold commas ("Korea, Republic of"), quotes ("") and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field.trim()); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field.trim()); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field.trim());
  if (row.some((v) => v !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function playReports(token, bucket) {
  const now = new Date();
  const months = [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))]
    .map((d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  const num = (v) => (v === undefined || v === "" ? null : Number(v));
  const installs = [], crashes = [];
  for (const m of months) {
    const inst = await playCsv(token, bucket, `stats/installs/installs_${PACKAGE}_${m}_overview.csv`);
    for (const r of inst || []) {
      if (!r.Date) continue;
      installs.push({ date: r.Date, userInstalls: num(r["Daily User Installs"]), deviceInstalls: num(r["Daily Device Installs"]),
                      userUninstalls: num(r["Daily User Uninstalls"]), activeDevices: num(r["Active Device Installs"]),
                      totalUsers: num(r["Total User Installs"]) });
    }
    const cr = await playCsv(token, bucket, `stats/crashes/crashes_${PACKAGE}_${m}_overview.csv`);
    for (const r of cr || []) {
      if (!r.Date) continue;
      crashes.push({ date: r.Date, crashes: num(r["Daily Crashes"]) || 0, anrs: num(r["Daily ANRs"]) || 0 });
    }
  }
  if (!installs.length) throw new SourceError("El depósito " + bucket + " aún no tiene informes de instalaciones.");
  return { installs, crashes };
}

// ------------------------------------------------------------ AdMob

async function admob(token, appId) {
  const accounts = (await call(token, `${ADMOB_API}/accounts`)).account || [];
  if (!accounts.length) throw new SourceError("La cuenta de Google no tiene acceso a AdMob.");
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 29 * 86400000);
  const date = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  const items = await call(token, `${ADMOB_API}/${accounts[0].name}/networkReport:generate`, {
    reportSpec: {
      // Up to yesterday: today's half day would pull the 7-day sums and eCPM down.
      dateRange: { startDate: date(start), endDate: date(end) },
      dimensions: ["DATE", "FORMAT"],
      metrics: ["AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS", "ESTIMATED_EARNINGS"],
      dimensionFilters: [{ dimension: "APP", matchesAny: { values: [appId] } }],
      localizationSettings: { currencyCode: "USD" },
    },
  });
  const rows = [];
  for (const item of items) {
    if (!item.row) continue;
    const d = item.row.dimensionValues, m = item.row.metricValues;
    const n = (k) => Number((m[k] || {}).integerValue || 0);
    rows.push({
      date: `${d.DATE.value.slice(0, 4)}-${d.DATE.value.slice(4, 6)}-${d.DATE.value.slice(6)}`,
      format: (d.FORMAT || {}).value || "",
      requests: n("AD_REQUESTS"), matched: n("MATCHED_REQUESTS"), impressions: n("IMPRESSIONS"), clicks: n("CLICKS"),
      earnings: Number((m.ESTIMATED_EARNINGS || {}).microsValue || 0) / 1e6,
    });
  }
  return { rows };
}

// ------------------------------------------------------------ Unity Ads

async function unity(apiKey, orgId, gameId) {
  // Up to the start of today (UTC): the day in progress is left out, as with AdMob.
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 86400000);
  const params = new URLSearchParams({
    fields: "adrequest_count,available_sum,revenue_sum,start_count,view_count",
    scale: "day", start: start.toISOString(), end: end.toISOString(),
  });
  if (gameId) params.set("gameIds", gameId);
  const url = `https://monetization.api.unity.com/stats/v1/operate/organizations/${orgId}`;
  // The key goes only in the header: in a query string it could end up in proxy logs.
  const res = await fetch(`${url}?${params}`, {
    headers: { Accept: "text/csv", Authorization: "Token " + apiKey }, signal: AbortSignal.timeout(18000),
  });
  if (!res.ok) {
    const hint = { 401: " (Unity no acepta la clave: revisa que sea la de «Monetization Stats API Access» y que tu usuario tenga rol de propietario o gestor)",
                   404: " (Unity no encuentra la organización: revisa UNITY_ORG_ID, el «Organization core ID» de Monetización ▸ Configuración)" }[res.status] || "";
    throw new SourceError(res.status + " " + (await res.text()).slice(0, 160) + hint);
  }
  const rows = parseCsv(await res.text()).map((r) => ({
    date: (r.timestamp || r.date || "").slice(0, 10),
    requests: Number(r.adrequest_count || 0), starts: Number(r.start_count || 0),
    views: Number(r.view_count || 0), revenue: Number(r.revenue_sum || 0),
  }));
  return { rows };
}

module.exports = { analytics, realtime, playVitals, playReports, admob, unity, parseCsv, SourceError };
