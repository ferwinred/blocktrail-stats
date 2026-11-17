// The page's arithmetic, apart from the page so it can be tested: periods,
// the summary strip, retention by install week and the funnels. Plain data in,
// plain data out; nothing here touches the DOM.

/** Below these sizes a change is noise: it is shown, but not coloured as good or bad. */
export const SMALL = { dauDays: 200, cohort: 100, crashUsers: 500, requests: 1000 };

const DAY = 86400000;

/** "20261117" (Analytics) or "2026-11-17T…" → "2026-11-17". */
export function dayKey(d) {
  const s = String(d);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s.slice(0, 10);
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The period that ends yesterday and the one just before it, as inclusive
 * [from, to] date keys, like Analytics' "NdaysAgo".."yesterday".
 */
export function windowsFor(period, today = new Date()) {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return {
    cur: [iso(t - period * DAY), iso(t - DAY)],
    prev: [iso(t - 2 * period * DAY), iso(t - (period + 1) * DAY)],
  };
}

export const inWindow = (date, [from, to]) => date >= from && date <= to;

/** Every date of a window, oldest first. */
export function datesOf([from, to]) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(iso(t));
  return out;
}

/** Sums `value(row)` per date key. */
function perDay(rows, dateOf, value) {
  const m = new Map();
  for (const r of rows || []) {
    const k = dayKey(dateOf(r));
    m.set(k, (m.get(k) || 0) + (Number(value(r)) || 0));
  }
  return m;
}

const sumOver = (map, dates) => dates.reduce((a, d) => a + (map.get(d) || 0), 0);
const ratio = (a, b) => (b ? a / b : null);

/**
 * The summary strip: one tile per figure, each with the current and previous
 * period, a daily series for the sparkline and whether the sample is too small.
 */
export function summary({ analytics, admob, unity, vitals, retention }, period, today = new Date()) {
  const w = windowsFor(period, today);
  const curDays = datesOf(w.cur), prevDays = datesOf(w.prev);

  const daily = analytics ? analytics.daily || [] : null;
  const dau = perDay(daily, (r) => r.date, (r) => r.activeUsers);
  const buys = perDay(daily, (r) => r.date, (r) => r.purchaseRevenue);
  const adEarn = perDay(admob && admob.rows, (r) => r.date, (r) => r.earnings);
  const adImps = perDay(admob && admob.rows, (r) => r.date, (r) => r.impressions);
  const adReq = perDay(admob && admob.rows, (r) => r.date, (r) => r.requests);
  const adMatched = perDay(admob && admob.rows, (r) => r.date, (r) => r.matched);
  const unRev = perDay(unity && unity.rows, (r) => r.date, (r) => r.revenue);
  const unViews = perDay(unity && unity.rows, (r) => r.date, (r) => r.views);

  const revenueOn = (d) => (adEarn.get(d) || 0) + (unRev.get(d) || 0) + (buys.get(d) || 0);
  const revenue = (days) => days.reduce((a, d) => a + revenueOn(d), 0);
  const imps = (days) => sumOver(adImps, days) + sumOver(unViews, days);
  const dauDays = (days) => sumOver(dau, days);
  const series = (f) => curDays.map((d) => ({ date: d, v: f(d) }));

  const tiles = [];
  const haveMoney = !!(admob || unity || analytics);
  tiles.push({
    key: "revenue", label: "Ingresos", format: "usd", goodWhenUp: true,
    cur: haveMoney ? revenue(curDays) : null, prev: haveMoney ? revenue(prevDays) : null,
    series: series(revenueOn),
    small: dauDays(prevDays) < SMALL.dauDays,
    note: "AdMob + Unity Ads + compras (brutas, antes de la comisión de Play).",
  });
  tiles.push({
    key: "arpdau", label: "ARPDAU", format: "usd3", goodWhenUp: true,
    cur: daily ? ratio(revenue(curDays), dauDays(curDays)) : null,
    prev: daily ? ratio(revenue(prevDays), dauDays(prevDays)) : null,
    series: series((d) => ratio(revenueOn(d), dau.get(d) || 0)),
    small: dauDays(prevDays) < SMALL.dauDays || dauDays(curDays) < SMALL.dauDays,
    note: "Ingresos ÷ suma de jugadores activos de cada día.",
  });
  tiles.push({
    key: "impsPerDau", label: "Anuncios por jugador al día", format: "n2", goodWhenUp: true,
    cur: daily ? ratio(imps(curDays), dauDays(curDays)) : null,
    prev: daily ? ratio(imps(prevDays), dauDays(prevDays)) : null,
    series: series((d) => ratio((adImps.get(d) || 0) + (unViews.get(d) || 0), dau.get(d) || 0)),
    small: dauDays(prevDays) < SMALL.dauDays || dauDays(curDays) < SMALL.dauDays,
    note: "Impresiones de AdMob + vistas de Unity ÷ jugadores activos por día.",
  });
  tiles.push({
    key: "fill", label: "Fill rate AdMob", format: "pct", goodWhenUp: true,
    cur: admob ? ratio(sumOver(adMatched, curDays), sumOver(adReq, curDays)) : null,
    prev: admob ? ratio(sumOver(adMatched, prevDays), sumOver(adReq, prevDays)) : null,
    series: series((d) => ratio(adMatched.get(d) || 0, adReq.get(d) || 0)),
    small: sumOver(adReq, prevDays) < SMALL.requests,
    note: "Solicitudes que AdMob llenó con un anuncio.",
  });

  const d1 = (win) => {
    const cs = (retention ? retention.cohorts : []).filter((c) => inWindow(c.date, win) && c.active[1] != null);
    const size = cs.reduce((a, c) => a + c.size, 0);
    return { rate: ratio(cs.reduce((a, c) => a + c.active[1], 0), size), size };
  };
  const d1Cur = d1(w.cur), d1Prev = d1(w.prev);
  const cohortOn = new Map((retention ? retention.cohorts : []).map((c) => [c.date, c]));
  tiles.push({
    key: "d1", label: "Vuelven al día siguiente (D1)", format: "pct", goodWhenUp: true,
    cur: retention ? d1Cur.rate : null, prev: retention ? d1Prev.rate : null,
    series: series((d) => { const c = cohortOn.get(d); return c && c.active[1] != null ? ratio(c.active[1], c.size) : null; }),
    small: d1Cur.size < SMALL.cohort || d1Prev.size < SMALL.cohort,
    note: `De ${d1Cur.size} instalaciones del periodo con el día 1 ya cumplido.`,
  });

  const crash = (win) => {
    const rows = (vitals ? vitals.crash : []).filter((r) => inWindow(r.date, win) && r.userPerceivedCrashRate != null);
    const users = rows.reduce((a, r) => a + (r.distinctUsers || 0), 0);
    return { rate: ratio(rows.reduce((a, r) => a + r.userPerceivedCrashRate * (r.distinctUsers || 0), 0), users), users };
  };
  const crCur = crash(w.cur), crPrev = crash(w.prev);
  const crashOn = new Map((vitals ? vitals.crash : []).map((r) => [r.date, r.userPerceivedCrashRate]));
  tiles.push({
    key: "crash", label: "Fallos percibidos", format: "pct2", goodWhenUp: false,
    cur: vitals ? crCur.rate : null, prev: vitals ? crPrev.rate : null,
    series: series((d) => (crashOn.has(d) ? crashOn.get(d) : null)),
    small: crCur.users < SMALL.crashUsers || crPrev.users < SMALL.crashUsers,
    limit: 0.0109,
    note: "Android vitals, ponderado por usuarios. Play penaliza por encima del 1,09 %.",
  });
  return { windows: w, tiles };
}

/**
 * How a figure moved: the text and whether to colour it. A small sample, or
 * nothing to compare with, is shown without colour.
 */
export function change(cur, prev, { goodWhenUp = true, small = false } = {}) {
  if (cur == null || prev == null) return { text: "", tone: null };
  if (prev === 0) return { text: cur ? "nuevo" : "±0 %", tone: null };
  const c = (cur - prev) / prev;
  const sign = c > 0 ? "+" : c < 0 ? "−" : "±";
  const text = sign + new Intl.NumberFormat("es-CO", { maximumFractionDigits: Math.abs(c) < 0.1 ? 1 : 0 }).format(Math.abs(c) * 100) + " %";
  if (small || c === 0) return { text, tone: null };
  return { text, tone: (c > 0) === goodWhenUp ? "up" : "down" };
}

/** Monday of the week a date key falls in. */
export function weekOf(date) {
  const t = Date.parse(date);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return iso(t - dow * DAY);
}

/**
 * Daily install cohorts grouped by install week: the size and, for each day N,
 * the share still active, counting only the days of that week already past N.
 */
export function cohortWeeks(retention) {
  if (!retention) return [];
  const by = new Map();
  for (const c of retention.cohorts) {
    const k = weekOf(c.date);
    const g = by.get(k) || { week: k, size: 0, days: 0, sizes: {}, active: {} };
    g.size += c.size; g.days++;
    for (const n of retention.days) {
      if (c.active[n] == null) continue;
      g.sizes[n] = (g.sizes[n] || 0) + c.size;
      g.active[n] = (g.active[n] || 0) + c.active[n];
    }
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.week.localeCompare(a.week)).map((g) => ({
    week: g.week, size: g.size, days: g.days,
    rates: Object.fromEntries(retention.days.map((n) => [n, g.sizes[n] ? g.active[n] / g.sizes[n] : null])),
    // Part of the week has not reached day N yet: the figure is the days that have.
    partial: Object.fromEntries(retention.days.map((n) => [n, g.sizes[n] != null && g.sizes[n] < g.size])),
  }));
}

/** Each step of a funnel: users, share of the first step and of the step before. */
export function funnel(steps, users) {
  const first = users[steps[0]] || 0;
  return steps.map((s, i) => {
    const n = users[s] || 0;
    const before = i ? users[steps[i - 1]] || 0 : n;
    return { step: s, users: n, ofFirst: first ? n / first : null, ofPrev: before ? n / before : null };
  });
}

/**
 * The level table: win rate against the rate the difficulty model expected, and
 * how many of the players who started a level started the next one.
 */
export function levelRows(levels) {
  if (!levels) return null;
  return levels.map((l, i) => {
    const played = l.wins + l.losses;
    const next = levels[i + 1];
    const winRate = played ? l.wins / played : null;
    return {
      ...l,
      winRate,
      gap: winRate != null && l.expectedWin != null ? winRate - l.expectedWin : null,
      continueRate: next && l.startedUsers ? Math.min(1, next.startedUsers / l.startedUsers) : null,
    };
  });
}
