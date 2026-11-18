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

/** How far back the daily sources reach: two of the longest period, so it can be compared. */
const HISTORY_DAYS = 180;

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

/** The periods the page offers, in days. */
const PERIODS = [7, 28, 90];

/** The period that ends yesterday, and the one just before it, as GA4 date ranges. */
function windows(period) {
  return {
    cur: { startDate: period + "daysAgo", endDate: "yesterday", name: "cur" },
    prev: { startDate: 2 * period + "daysAgo", endDate: period + 1 + "daysAgo", name: "prev" },
  };
}

/** The first session, step by step: who got how far. */
const FIRST_SESSION = ["first_open", "tutorial_step", "first_piece_placed", "first_line_cleared", "level_complete"];
const LEVEL_EVENTS = ["level_start", "level_complete", "level_fail"];

/** Runs a report that needs a custom dimension or metric; null when Analytics does not know it yet. */
async function optional(report, body) {
  try {
    return await report(body);
  } catch (err) {
    if (err instanceof SourceError && err.message.startsWith("400")) return null;
    throw err;
  }
}

/** Splits the rows of a two-range report into { cur, prev }. */
function byRange(rows) {
  const out = { cur: [], prev: [] };
  for (const r of rows) (out[r.dateRange] || (out[r.dateRange] = [])).push(r);
  return out;
}

async function analytics(token, property, period = 7) {
  if (!PERIODS.includes(period)) period = 7;
  const prop = "properties/" + property;
  const { cur, prev } = windows(period);
  // Whether testers can be left out: a 400 means the dimension is not registered yet.
  // Asked with a short timeout, so a slow Analytics does not spend the source's whole budget here.
  let excludeTesters = false;
  let testers = null;
  try {
    testers = rowsOf(await call(token, `${DATA_API}/${prop}:runReport`, {
      dateRanges: [cur], dimensions: [{ name: TESTER_DIMENSION }], metrics: [{ name: "activeUsers" }],
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
  const eventFilter = (values) => ({ filter: { fieldName: "eventName", inListFilter: { values } } });

  const [daily, totals, events, countries, versions, firstSession, levels, expected, promoRows, campaignRows, valueRows] = await Promise.all([
    // Both periods by day: the sparklines and the per-day sums (DAU-days) come from here.
    report({ dateRanges: [{ startDate: 2 * period + "daysAgo", endDate: "yesterday" }], dimensions: [{ name: "date" }],
             metrics: ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "purchaseRevenue", "totalPurchasers"].map((name) => ({ name })),
             orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 }),
    report({ dateRanges: [cur, prev], metrics: totalsMetrics }),
    report({ dateRanges: [cur, prev], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
             dimensionFilter: eventFilter(GAME_EVENTS) }),
    report({ dateRanges: [cur], dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "userEngagementDuration" }],
             orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 12 }),
    report({ dateRanges: [cur], dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }],
             orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] }),
    // Players new in the period: how many reached each first-session step.
    report({ dateRanges: [cur, prev], dimensions: [{ name: "eventName" }], metrics: [{ name: "totalUsers" }],
             dimensionFilter: { andGroup: { expressions: [eventFilter(FIRST_SESSION),
               { filter: { fieldName: "newVsReturning", stringFilter: { value: "new" } } }] } } }),
    // Per level: needs level_id registered as an event-scoped custom dimension.
    optional(report, { dateRanges: [cur], dimensions: [{ name: "customEvent:level_id" }, { name: "eventName" }],
                       metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: eventFilter(LEVEL_EVENTS), limit: 2000 }),
    // What the difficulty model expected: needs expected_win registered as a custom metric.
    optional(report, { dateRanges: [cur], dimensions: [{ name: "customEvent:level_id" }],
                       metrics: [{ name: "averageCustomEvent:expected_win" }], dimensionFilter: eventFilter(["level_complete", "level_fail"]), limit: 2000 }),
    // Each promotion: shown, tapped, bought (needs promotion registered as an event-scoped dimension).
    optional(report, { dateRanges: [cur], dimensions: [{ name: "customEvent:promotion" }, { name: "eventName" }],
                       metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: eventFilter(PROMO_EVENTS), limit: 1000 }),
    // Each campaign: the players who had it, and what they spent (needs active_event as a user-scoped dimension).
    optional(report, { dateRanges: [cur], dimensions: [{ name: "customUser:active_event" }],
                       metrics: ["activeUsers", "totalPurchasers", "purchaseRevenue", "totalAdRevenue", "userEngagementDuration"].map((name) => ({ name })),
                       limit: 200 }),
    // What a player is worth by country, over 90 days whatever the period (for LTV against CPI).
    report({ dateRanges: [{ startDate: "90daysAgo", endDate: "yesterday" }], dimensions: [{ name: "country" }, { name: "countryId" }],
             metrics: ["activeUsers", "newUsers", "totalPurchasers", "totalRevenue"].map((name) => ({ name })),
             orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 30 }),
  ]);

  const t = byRange(totals);
  const ev = byRange(events);
  const fs = byRange(firstSession);
  const usersOf = (rows) => Object.fromEntries(rows.map((r) => [r.eventName, r.totalUsers]));
  return {
    property, period, excludeTesters, testers,
    totals: { cur: t.cur[0] || {}, prev: t.prev[0] || {} },
    daily, countries, versions,
    events: Object.fromEntries([...new Set(events.map((e) => e.eventName))].map((name) => {
      const c = ev.cur.find((x) => x.eventName === name) || {}, p = ev.prev.find((x) => x.eventName === name) || {};
      return [name, { count: c.eventCount || 0, users: c.totalUsers || 0, prevCount: p.eventCount || 0, prevUsers: p.totalUsers || 0 }];
    })),
    firstSession: { steps: FIRST_SESSION, cur: usersOf(fs.cur), prev: usersOf(fs.prev) },
    levels: levels && levelTable(levels, expected),
    promotions: promoRows && promoTable(promoRows),
    countryValue: valueRows.map((r) => ({ country: r.country, code: r.countryId, users: r.activeUsers, newUsers: r.newUsers, buyers: r.totalPurchasers, revenue: r.totalRevenue })),
    campaigns: campaignRows && campaignRows
      .filter((r) => r["customUser:active_event"] && r["customUser:active_event"] !== "(not set)" && r["customUser:active_event"] !== "none")
      .map((r) => ({ id: r["customUser:active_event"], users: r.activeUsers, buyers: r.totalPurchasers,
                     revenue: r.purchaseRevenue, adRevenue: r.totalAdRevenue, minutes: r.activeUsers ? r.userEngagementDuration / 60 / r.activeUsers : null }))
      .sort((a, b) => b.users - a.users),
  };
}

const PROMO_EVENTS = ["promo_shown", "promo_tapped", "shop_purchase"];

/** One row per promotion: how often and to how many it was shown, tapped and bought. */
function promoTable(rows) {
  const by = {};
  for (const r of rows) {
    const id = r["customEvent:promotion"];
    if (!id || id === "(not set)") continue;
    const p = (by[id] ||= { id, shown: 0, shownUsers: 0, tapped: 0, tappedUsers: 0, purchases: 0, buyers: 0 });
    if (r.eventName === "promo_shown") { p.shown = r.eventCount; p.shownUsers = r.totalUsers; }
    if (r.eventName === "promo_tapped") { p.tapped = r.eventCount; p.tappedUsers = r.totalUsers; }
    if (r.eventName === "shop_purchase") { p.purchases = r.eventCount; p.buyers = r.totalUsers; }
  }
  return Object.values(by).sort((a, b) => b.shownUsers - a.shownUsers);
}

/** One row per level: who started it, wins and losses, and the expected win rate. */
function levelTable(rows, expected) {
  const by = {};
  for (const r of rows) {
    const id = r["customEvent:level_id"];
    if (!id || id === "(not set)") continue;
    const l = (by[id] ||= { id, startedUsers: 0, starts: 0, wins: 0, losses: 0, winUsers: 0, expectedWin: null });
    if (r.eventName === "level_start") { l.starts = r.eventCount; l.startedUsers = r.totalUsers; }
    if (r.eventName === "level_complete") { l.wins = r.eventCount; l.winUsers = r.totalUsers; }
    if (r.eventName === "level_fail") l.losses = r.eventCount;
  }
  for (const e of expected || []) {
    const l = by[e["customEvent:level_id"]];
    const v = Number(e["averageCustomEvent:expected_win"]);
    if (l && Number.isFinite(v)) l.expectedWin = v;
  }
  return Object.values(by).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/**
 * An experiment: the players on the control release (A) against the ones on
 * the variant (B), told apart by the user property content_pack the game sets
 * every session, from the day it started. Testers are left out when known.
 */
async function experiment(token, property, { control, variant, since }) {
  const prop = "properties/" + property;
  const groups = [String(control), String(variant)];
  const pack = { filter: { fieldName: "customUser:content_pack", inListFilter: { values: groups } } };
  const both = { andGroup: { expressions: [pack, TESTER_FILTER] } };
  const run = async (body, filter) => {
    try { return rowsOf(await call(token, `${DATA_API}/${prop}:runReport`, { ...body, dimensionFilter: filter })); }
    catch (err) {
      if (err instanceof SourceError && err.message.startsWith("400") && filter === both)
        return rowsOf(await call(token, `${DATA_API}/${prop}:runReport`, { ...body, dimensionFilter: pack }));
      throw err;
    }
  };
  const range = [{ startDate: since, endDate: "yesterday" }];
  const totals = await run({ dateRanges: range, dimensions: [{ name: "customUser:content_pack" }],
    metrics: ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "totalPurchasers", "purchaseRevenue", "totalAdRevenue"].map((name) => ({ name })) }, both);
  // Day-1 return of the players who started during the experiment, per group.
  const d1 = await Promise.all(groups.map(async (g) => {
    const one = { filter: { fieldName: "customUser:content_pack", stringFilter: { value: g } } };
    try {
      const rows = rowsOf(await call(token, `${DATA_API}/${prop}:runReport`, {
        dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }],
        metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
        dimensionFilter: one,
        cohortSpec: { cohorts: [{ name: "c", dimension: "firstSessionDate", dateRange: { startDate: since, endDate: "2daysAgo" } }],
                      cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 1 } },
      }));
      const day1 = rows.find((r) => Number(r.cohortNthDay) === 1);
      return { size: day1 ? day1.cohortTotalUsers : rows[0] ? rows[0].cohortTotalUsers : 0, back: day1 ? day1.cohortActiveUsers : 0 };
    } catch { return null; }
  }));
  const of = (g) => totals.find((r) => r["customUser:content_pack"] === g) || {};
  return {
    control, variant, since,
    groups: groups.map((g, i) => ({ version: Number(g), ...pick(of(g)), d1: d1[i] })),
  };
}

const pick = (r) => ({
  users: r.activeUsers || 0, newUsers: r.newUsers || 0, sessions: r.sessions || 0, engagement: r.userEngagementDuration || 0,
  buyers: r.totalPurchasers || 0, purchaseRevenue: r.purchaseRevenue || 0, adRevenue: r.totalAdRevenue || 0,
});

/**
 * Daily install cohorts of the last eight weeks, and how many were still active
 * on days 1, 3, 7, 14 and 30. The page groups them by week and by period.
 */
const RETENTION_DAYS = [1, 3, 7, 14, 30];

async function retention(token, property) {
  const prop = "properties/" + property;
  const today = new Date();
  const days = [];
  for (let i = 2; i < 58; i++) days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  const chunks = [];
  for (let i = 0; i < days.length; i += 8) chunks.push(days.slice(i, i + 8));
  const ask = (chunk, filter) => call(token, `${DATA_API}/${prop}:runReport`, {
    dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }],
    metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
    ...(filter ? { dimensionFilter: filter } : {}),
    cohortSpec: {
      cohorts: chunk.map((d) => ({ name: d.replaceAll("-", ""), dimension: "firstSessionDate", dateRange: { startDate: d, endDate: d } })),
      cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 30 },
    },
  }).then(rowsOf);
  // Testers left out when Analytics knows the mark; otherwise everyone.
  let rows;
  try {
    rows = (await Promise.all(chunks.map((c) => ask(c, TESTER_FILTER)))).flat();
  } catch (err) {
    if (!(err instanceof SourceError && err.message.startsWith("400"))) throw err;
    rows = (await Promise.all(chunks.map((c) => ask(c)))).flat();
  }
  return { days: RETENTION_DAYS, cohorts: cohortRows(rows, today) };
}

/** Folds GA4's cohort rows into { date, age, size, active: { n: users } }, newest first. */
function cohortRows(rows, today) {
  const by = {};
  for (const r of rows) {
    const c = (by[r.cohort] ||= { size: 0, active: {} });
    c.size = Math.max(c.size, Number(r.cohortTotalUsers) || 0);
    const n = Number(r.cohortNthDay);
    if (RETENTION_DAYS.includes(n)) c.active[n] = Number(r.cohortActiveUsers) || 0;
  }
  return Object.entries(by).map(([name, c]) => {
    const date = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6)}`;
    // Days fully past since that install day: day N is known once age > N.
    const age = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.parse(date)) / 86400000);
    const active = {};
    for (const n of RETENTION_DAYS) if (age > n) active[n] = c.active[n] || 0;
    return { date, age, size: c.size, active };
  }).sort((a, b) => b.date.localeCompare(a.date));
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
  const start = new Date(Date.UTC(end.year, end.month - 1, end.day) - HISTORY_DAYS * 86400000);
  const body = {
    timelineSpec: { aggregationPeriod: "DAILY", startTime: playDate({ year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() }), endTime: playDate(end) },
    metrics, pageSize: 1000,
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
  // Seven monthly files cover two 90-day periods.
  const months = [6, 5, 4, 3, 2, 1, 0].map((back) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)))
    .map((d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  const num = (v) => (v === undefined || v === "" ? null : Number(v));
  const files = await Promise.all(months.map((m) => Promise.all([
    playCsv(token, bucket, `stats/installs/installs_${PACKAGE}_${m}_overview.csv`),
    playCsv(token, bucket, `stats/crashes/crashes_${PACKAGE}_${m}_overview.csv`),
  ])));
  const installs = [], crashes = [];
  for (const [inst, cr] of files) {
    for (const r of inst || []) {
      if (!r.Date) continue;
      installs.push({ date: r.Date, userInstalls: num(r["Daily User Installs"]), deviceInstalls: num(r["Daily Device Installs"]),
                      userUninstalls: num(r["Daily User Uninstalls"]), activeDevices: num(r["Active Device Installs"]),
                      totalUsers: num(r["Total User Installs"]) });
    }
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
  const start = new Date(end.getTime() - (HISTORY_DAYS - 1) * 86400000);
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
  const start = new Date(end.getTime() - HISTORY_DAYS * 86400000);
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

module.exports = {
  analytics, retention, experiment, realtime, playVitals, playReports, admob, unity,
  parseCsv, cohortRows, levelTable, promoTable, PERIODS, SourceError,
};
