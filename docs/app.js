import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js?v=202611171800";
import { change, cohortWeeks, datesOf, dayKey, funnel, inWindow, levelRows, SMALL, summary, windowsFor } from "./metrics.js?v=202611171800";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const stats = httpsCallable(getFunctions(app, "us-central1"), "stats", { timeout: 70000 });

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("es-CO");
const n1 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const n2 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usd = new Intl.NumberFormat("es-CO", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd3 = new Intl.NumberFormat("es-CO", { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (v) => (v == null ? "—" : n1.format(v * 100) + " %");
const pct2 = (v) => (v == null ? "—" : n2.format(v * 100) + " %");
const int = (v) => (v == null ? "—" : nf.format(v));
const FORMAT = { usd: (v) => (v == null ? "—" : usd.format(v)), usd3: (v) => (v == null ? "—" : usd3.format(v)),
                 n2: (v) => (v == null ? "—" : n2.format(v)), pct, pct2 };
const shortDate = (key) => key.slice(8) + "/" + key.slice(5, 7);

const EVENT_LABELS = {
  first_open: "Instalaciones (primera apertura)", app_remove: "Desinstalaciones", session_start: "Sesiones",
  level_start: "Niveles empezados", level_complete: "Niveles ganados", level_fail: "Niveles perdidos",
  level_continue: "Continuar tras perder", daily_reward_claim: "Recompensa diaria", daily_challenge_start: "Reto del día empezado",
  daily_challenge_complete: "Reto del día ganado", zen_start: "Partidas de modo clásico", zen_end: "Modo clásico terminado",
  shop_view: "Visitas a la tienda", shop_purchase: "Compras en la tienda", in_app_purchase: "Compras con dinero",
  world_purchased: "Mundos comprados con gemas", world_unlocked: "Mundos abiertos por jefe", booster_used: "Potenciadores usados",
  ad_requested: "Anuncios pedidos", ad_shown: "Anuncios mostrados", ad_reward_granted: "Recompensas por anuncio",
  ad_impression: "Impresiones con ingreso", ad_paid: "Ingreso por anuncio registrado", ad_slot_missed: "Anuncio sin llenar",
  review_prompt: "Petición de reseña", push_setting: "Cambios de notificaciones", push_prompt: "Petición de notificaciones",
  sign_in_prompt: "Invitación a iniciar sesión", run_resume: "Partida retomada", mission_complete: "Misiones completadas",
  mission_claim: "Misiones cobradas", win_streak_reward: "Premio por racha de victorias", currency_earned: "Monedas ganadas",
  currency_spent: "Monedas gastadas", tutorial_step: "Pasos del tutorial", first_piece_placed: "Primera pieza colocada",
  first_line_cleared: "Primera línea completada", promo_shown: "Promociones mostradas", promo_tapped: "Promociones tocadas",
  event_theme: "Tema de campaña activo", event_theme_unlock: "Tema de campaña desbloqueado", startup_time: "Arranques medidos",
};
const FIRST_SESSION_LABELS = {
  first_open: "Abren el juego", tutorial_step: "Empiezan el tutorial", first_piece_placed: "Colocan la primera pieza",
  first_line_cleared: "Completan la primera línea", level_complete: "Ganan un nivel",
};
const FORMATS = { interstitial: "Intersticial", rewarded: "Recompensa", rewarded_interstitial: "Bonificado intersticial", banner: "Banner", app_open: "Apertura" };
const SOURCE_NAMES = { realtime: "El tiempo real", analytics: "Google Analytics", retention: "La retención", admob: "AdMob",
                       unity: "Unity Ads", playReports: "Los informes de Play", playVitals: "Android vitals" };

let last = null;
let realtimeTimer = null;

// ---------------------------------------------------------------- preferences

function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private window: lasts this visit */ } }
function recall(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  remember("bt-theme", choice);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice)));
  // The charts take their colours from the theme, so they are drawn again.
  if (last) render(last);
}
document.querySelectorAll("[data-theme-choice]").forEach((b) => { b.onclick = () => applyTheme(b.dataset.themeChoice); });

let period = [7, 28, 90].includes(Number(recall("bt-period", 7))) ? Number(recall("bt-period", 7)) : 7;
function showPeriod() {
  document.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.period) === period)));
  document.querySelectorAll(".per").forEach((el) => { el.textContent = period + " días"; });
}
document.querySelectorAll("[data-period]").forEach((b) => {
  b.onclick = () => {
    const p = Number(b.dataset.period);
    if (p === period) return;
    period = p;
    remember("bt-period", String(p));
    showPeriod();
    // Only Analytics is asked again: the other sources already hold 180 days.
    if (last) render(last);
    load({ only: ["analytics"] });
  };
});
showPeriod();
applyTheme(recall("bt-theme", "auto"));

// ---------------------------------------------------------------- session

$("signin").onclick = async () => {
  $("login-error").hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    showLoginError(err.code === "auth/unauthorized-domain"
      ? "Este dominio no está autorizado en Firebase Auth."
      : "No se pudo iniciar sesión: " + (err.message || err));
  }
};
$("logout").onclick = () => signOut(auth);
$("refresh").onclick = () => load({ force: true });

onAuthStateChanged(auth, (user) => {
  clearInterval(realtimeTimer);
  $("session").hidden = !user;
  $("period").hidden = !user;
  $("jump").hidden = !user;
  $("login").hidden = !!user;
  $("app").hidden = !user;
  if (!user) return;
  $("who").textContent = user.email;
  load({});
  // The live numbers again every minute while the tab is open; the rest follows the backend's cache.
  realtimeTimer = setInterval(() => { if (!document.hidden) load({ only: ["realtime"] }); }, 60000);
});

function showLoginError(text) {
  $("login-error").textContent = text;
  $("login-error").hidden = false;
}

let loading = 0;
async function load({ only = null, force = false }) {
  loading++;
  if (!only || only.includes("analytics")) $("status").textContent = "Cargando…";
  $("strip").setAttribute("aria-busy", "true");
  $("refresh").disabled = true;
  try {
    const res = await stats({ only, force, period });
    // A period changed while this was on its way: the newer request will render.
    if (res.data.period !== period && (!only || only.includes("analytics"))) return;
    last = only && last ? { ...last, sources: { ...last.sources, ...res.data.sources } } : res.data;
    render(last);
  } catch (err) {
    if (err.code === "functions/permission-denied" || err.code === "functions/unauthenticated") {
      await signOut(auth);
      showLoginError(err.message);
      return;
    }
    $("status").textContent = "No se pudieron cargar las estadísticas (" + (err.message || err) + "). Revisa la conexión y pulsa Actualizar.";
  } finally {
    if (--loading === 0) { $("refresh").disabled = false; $("strip").setAttribute("aria-busy", "false"); }
  }
}

// ---------------------------------------------------------------- render

/** The data of a source, showing its error (with a retry) when it failed. */
function source(data, name) {
  const s = (data.sources || {})[name];
  const el = $("err-" + name);
  if (el) {
    el.hidden = !s || s.ok;
    if (s && !s.ok) {
      const text = document.createElement("span");
      text.textContent = (s.stale ? "Mostrando el último dato bueno (" + when(s.at) + "). " : "Sin datos. ")
        + SOURCE_NAMES[name] + " falló: " + s.error + " ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn small-btn";
      retry.textContent = "Reintentar";
      retry.onclick = () => load({ only: [name], force: true });
      el.replaceChildren(text, retry);
    }
  }
  return s && s.data ? s.data : null;
}

const when = (ms) => (ms ? new Date(ms).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—");

function setDelta(id, cur, prev, { goodWhenUp = true, small = false } = {}) {
  const el = $(id);
  if (!el) return;
  const c = change(cur, prev, { goodWhenUp, small });
  el.className = "delta" + (c.tone ? " " + c.tone : "");
  el.textContent = c.text ? c.text + " frente a los " + period + " días anteriores" : "";
}

function render(data) {
  const sources = data.sources || {};
  const newest = Math.max(0, ...Object.values(sources).map((s) => s.at || 0));
  $("status").textContent = "Actualizado: " + when(newest) + " · Cada fuente se reutiliza unos minutos para no agotar sus cuotas.";

  const ga = source(data, "analytics");
  const gaNow = ga && ga.period === period ? ga : null;
  const retention = source(data, "retention");
  const admob = source(data, "admob");
  const unity = source(data, "unity");
  const play = source(data, "playReports");
  const vitals = source(data, "playVitals");
  const w = windowsFor(period);

  renderStrip(summary({ analytics: gaNow, admob, unity, vitals, retention }, period));

  const rt = source(data, "realtime");
  if (rt) {
    $("rt-active").textContent = int(rt.activeUsers);
    $("rt-installs").textContent = int(rt.events.first_open || 0);
    $("rt-levels").textContent = int(rt.events.level_complete || 0) + " / " + int(rt.events.level_fail || 0);
    $("rt-ads").textContent = int(rt.events.ad_impression || 0);
    $("rt-countries").textContent = rt.countries.length
      ? "Por país: " + rt.countries.map((c) => c.country + " " + c.activeUsers).join(" · ") : "Nadie jugando en este momento.";
  }

  if (gaNow) renderAnalytics(gaNow);
  renderRetention(retention);
  if (admob) renderAdmob(admob, w);
  if (unity) {
    const rows = unity.rows.filter((r) => inWindow(dayKey(r.date), w.cur));
    $("un-rev").textContent = usd.format(rows.reduce((a, r) => a + r.revenue, 0));
    $("un-views").textContent = int(rows.reduce((a, r) => a + r.views, 0)) + " anuncios vistos";
  }
  if (play) renderPlay(play);
  if (vitals) {
    const lastCrash = vitals.crash.at(-1);
    $("pl-rate").textContent = lastCrash ? pct2(lastCrash.userPerceivedCrashRate) : "Sin datos";
    $("pl-rate-n").textContent = lastCrash ? "percibida, " + lastCrash.date + " · límite de Play 1,09 %" : "Play la publica con más usuarios diarios";
  }

  drawPlayersChart(gaNow ? gaNow.daily : [], play ? play.installs : [], w);
}

// ---------------------------------------------------------------- summary strip

function renderStrip({ tiles }) {
  $("strip").replaceChildren(...tiles.map((t) => {
    const card = document.createElement("div");
    card.className = "card tile" + (t.limit != null && t.cur != null && t.cur > t.limit ? " over" : "");
    const fmt = FORMAT[t.format];
    const c = change(t.cur, t.prev, { goodWhenUp: t.goodWhenUp, small: t.small });
    const detail = `${t.label}: ${fmt(t.cur)} en los últimos ${period} días; ${fmt(t.prev)} en los ${period} anteriores.`
      + (t.small ? " Muestra pequeña." : "") + " " + t.note;
    card.title = detail;
    const label = el("span", "label", t.label);
    const value = el("span", "value", fmt(t.cur));
    const delta = el("span", "delta" + (c.tone ? " " + c.tone : ""), c.text || "—");
    const sr = el("span", "sr", detail);
    card.append(label, value, sparkline(t.series), delta, sr);
    return card;
  }));
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** A tiny line of the daily values; gaps where a day has no figure. */
function sparkline(series) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 28");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("spark");
  const vals = series.map((p) => p.v).filter((v) => v != null && Number.isFinite(v));
  if (vals.length < 2) return svg;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  let d = "", open = false;
  series.forEach((p, i) => {
    if (p.v == null || !Number.isFinite(p.v)) { open = false; return; }
    const x = series.length === 1 ? 0 : (i * 100) / (series.length - 1);
    const y = 25 - ((p.v - min) / span) * 22;
    d += (open ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    open = true;
  });
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", d);
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------- sections

function renderAnalytics(ga) {
  const a = ga.totals.cur, p = ga.totals.prev;
  $("testers-note").textContent = ga.excludeTesters
    ? "Sin testers: las cifras son solo de jugadores reales."
    : "Incluye a los testers: Analytics todavía no reconoce su marca.";
  const small = (p.activeUsers || 0) < 50;
  $("ga-active").textContent = int(a.activeUsers);
  setDelta("ga-active-d", a.activeUsers, p.activeUsers, { small });
  $("ga-new").textContent = int(a.newUsers);
  setDelta("ga-new-d", a.newUsers, p.newUsers, { small });
  const mins = (t) => (t.activeUsers ? t.userEngagementDuration / 60 / t.activeUsers : null);
  $("ga-min").textContent = mins(a) == null ? "—" : n1.format(mins(a));
  setDelta("ga-min-d", mins(a), mins(p), { small });
  const ev = ga.events;
  const won = (ev.level_complete || {}).count || 0, lost = (ev.level_fail || {}).count || 0;
  $("ga-win").textContent = won + lost ? pct(won / (won + lost)) : "—";
  $("ga-buyers").textContent = int(a.totalPurchasers || 0);
  setDelta("ga-buyers-d", a.totalPurchasers || 0, p.totalPurchasers || 0, { small: true });
  $("rev-buy").textContent = usd.format(a.purchaseRevenue || 0);

  fill("t-countries", ga.countries.map((c) => [c.country, int(c.activeUsers), int(c.newUsers), c.activeUsers ? n1.format(c.userEngagementDuration / 60 / c.activeUsers) : "—"]));
  fill("t-versions", ga.versions.map((v) => [v.appVersion, int(v.activeUsers)]));
  fill("t-events", Object.entries(ev).sort((x, y) => y[1].count - x[1].count)
    .map(([k, v]) => [EVENT_LABELS[k] || k, int(v.count), int(v.users), change(v.count, v.prevCount, { small: true }).text || "—"]));

  // First session: of the players new in the period, how many got to each step.
  const steps = funnel(ga.firstSession.steps, ga.firstSession.cur);
  $("funnel-first").replaceChildren(...steps.map((s, i) => {
    const li = el("li");
    const bar = el("span", "bar");
    bar.style.setProperty("--w", ((s.ofFirst || 0) * 100).toFixed(1) + "%");
    li.append(el("span", "step", FIRST_SESSION_LABELS[s.step] || s.step), bar,
      el("span", "num", int(s.users) + (i ? " · " + pct(s.ofPrev) + " del paso anterior" : "")));
    return li;
  }));

  const levels = levelRows(ga.levels);
  if (!levels) {
    $("levels-note").textContent = "Para ver los niveles, registra en Google Analytics ▸ Definiciones personalizadas la dimensión de evento level_id y la métrica expected_win (estándar).";
    fill("t-levels", []);
  } else {
    $("levels-note").textContent = "Diferencia: ganadas menos lo que esperaba la dificultad adaptativa. Más de 10 puntos por debajo, en rojo.";
    fill("t-levels", levels.map((l) => [l.id, int(l.startedUsers), pct(l.winRate), pct(l.expectedWin),
      { text: l.gap == null ? "—" : (l.gap > 0 ? "+" : "") + n1.format(l.gap * 100) + " pts", cls: l.gap != null && l.gap < -0.1 && l.wins + l.losses >= 30 ? "down" : "" },
      pct(l.continueRate)]));
  }
}

function renderRetention(retention) {
  const weeks = cohortWeeks(retention);
  // The newest `period` days of installs that have already reached day 7.
  const reached = (retention ? retention.cohorts : []).filter((c) => c.active[7] != null);
  const newest = reached.length ? reached[0].date : null;
  const d7 = newest ? reached.filter((c) => c.date > shift(newest, -period)) : [];
  const size = d7.reduce((a, c) => a + c.size, 0);
  $("ga-d7").textContent = size ? pct(d7.reduce((a, c) => a + c.active[7], 0) / size) : "—";
  $("ga-d7-n").textContent = size ? "de " + int(size) + " instalaciones del " + shortDate(d7.at(-1).date) + " al " + shortDate(newest)
    : "aún no hay instalaciones con 7 días cumplidos";
  if (!retention) return;
  const body = document.querySelector("#t-cohorts tbody");
  body.replaceChildren(...weeks.map((g) => {
    const tr = el("tr", g.size < SMALL.cohort ? "thin" : "");
    tr.append(el("th", null, "Desde " + shortDate(g.week)), el("td", null, int(g.size)));
    tr.firstChild.scope = "row";
    for (const n of retention.days) {
      const v = g.rates[n];
      const td = el("td", "heat", v == null ? "" : pct(v) + (g.partial[n] ? "*" : ""));
      if (v != null) td.style.setProperty("--a", Math.min(1, v * 1.6).toFixed(2));
      tr.append(td);
    }
    return tr;
  }));
}

function renderAdmob(admob, w) {
  const recent = admob.rows.filter((r) => inWindow(r.date, w.cur));
  const sum = (k) => recent.reduce((a, r) => a + r[k], 0);
  const imps = sum("impressions"), earn = sum("earnings"), clicks = sum("clicks");
  $("ad-earn").textContent = usd.format(earn);
  $("ad-imps").textContent = int(imps) + " impresiones";
  $("ad-ecpm").textContent = imps ? usd.format(earn * 1000 / imps) : "—";
  $("ad-ctr").textContent = imps ? "tasa de clics " + pct(clicks / imps) : "";
  const byFormat = {};
  for (const r of recent) {
    const f = (byFormat[r.format] ||= { impressions: 0, clicks: 0, earnings: 0 });
    f.impressions += r.impressions; f.clicks += r.clicks; f.earnings += r.earnings;
  }
  fill("t-formats", Object.entries(byFormat).sort((x, y) => y[1].impressions - x[1].impressions)
    .map(([k, v]) => [FORMATS[k.toLowerCase()] || k, int(v.impressions), int(v.clicks), usd.format(v.earnings)]));
}

function renderPlay(play) {
  // Totals are running counts: the newest day that has them is the figure.
  const withTotal = [...play.installs].reverse().find((r) => r.totalUsers != null);
  $("pl-total").textContent = withTotal ? int(withTotal.totalUsers) : "—";
  $("pl-total-n").textContent = withTotal ? "usuarios únicos desde el lanzamiento, al " + withTotal.date : "";
  const withActive = [...play.installs].reverse().find((r) => r.activeDevices != null);
  $("pl-active").textContent = withActive ? int(withActive.activeDevices) : "—";
  // Play is days behind: the period is the last `period` days Play has, not the calendar's.
  const lastDay = play.installs.length ? play.installs.map((r) => r.date).sort().at(-1) : null;
  const inst = lastDay ? play.installs.filter((r) => r.date > shift(lastDay, -period) && r.date <= lastDay) : [];
  $("pl-inst").textContent = int(inst.reduce((a, r) => a + (r.userInstalls || 0), 0));
  $("pl-inst-n").textContent = lastDay ? period + " días hasta el " + lastDay : "";
  $("pl-uninst").textContent = int(inst.reduce((a, r) => a + (r.userUninstalls || 0), 0));
  const days = new Set(inst.map((r) => r.date));
  $("pl-crash").textContent = lastDay ? int(play.crashes.filter((r) => days.has(r.date)).reduce((a, r) => a + r.crashes + r.anrs, 0)) : "—";
}

const shift = (key, days) => new Date(Date.parse(key) + days * 86400000).toISOString().slice(0, 10);

function fill(id, rows) {
  const body = document.querySelector("#" + id + " tbody");
  body.replaceChildren(...rows.map((cells) => {
    const tr = document.createElement("tr");
    for (const c of cells) {
      const td = document.createElement("td");
      if (c && typeof c === "object") { td.textContent = c.text; if (c.cls) td.className = c.cls; } else td.textContent = c;
      tr.append(td);
    }
    return tr;
  }));
}

// ---------------------------------------------------------------- players chart

const SERIES = [
  { key: "a", label: "Activos", color: "--accent", dash: "" },
  { key: "n", label: "Nuevos (Analytics)", color: "--gold", dash: "6 4" },
  { key: "p", label: "Instalaciones (Play)", color: "--play", dash: "2 3" },
];

function drawPlayersChart(daily, installs, w) {
  const byDate = new Map(datesOf(w.cur).map((d) => [d, { date: d }]));
  for (const d of daily) {
    const p = byDate.get(dayKey(d.date));
    if (p) { p.a = d.activeUsers; p.n = d.newUsers; }
  }
  for (const r of installs) { const p = byDate.get(r.date); if (p) p.p = r.userInstalls; }
  const pts = [...byDate.values()];
  $("chart-legend").replaceChildren(...SERIES.map((s) => {
    const span = el("span");
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "22"); svg.setAttribute("height", "10"); svg.setAttribute("aria-hidden", "true");
    const line = document.createElementNS(svgNS, "line");
    Object.entries({ x1: 1, x2: 21, y1: 5, y2: 5, stroke: `var(${s.color})`, "stroke-width": 2.5, "stroke-dasharray": s.dash }).forEach(([k, v]) => line.setAttribute(k, v));
    svg.append(line);
    span.append(svg, document.createTextNode(s.label));
    return span;
  }));
  lineChart($("chart"), pts, SERIES, "Jugadores activos, nuevos e instalaciones de Play por día");

  // The same numbers as a table, for screen readers and for copying.
  const table = el("table");
  const head = el("tr");
  ["Día", ...SERIES.map((s) => s.label)].forEach((h) => { const th = el("th", null, h); th.scope = "col"; head.append(th); });
  const thead = el("thead"); thead.append(head);
  const tbody = el("tbody");
  for (const p of pts) {
    const tr = el("tr");
    tr.append(el("td", null, shortDate(p.date)), ...SERIES.map((s) => el("td", null, int(p[s.key]))));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  $("chart-table").replaceChildren(table);
}

$("chart-table-toggle").onclick = () => {
  const open = $("chart-table").hidden;
  $("chart-table").hidden = !open;
  $("chart-table-toggle").setAttribute("aria-expanded", String(open));
  $("chart-table-toggle").textContent = open ? "Ocultar la tabla" : "Ver como tabla";
};

function lineChart(box, pts, series, label) {
  box.replaceChildren();
  if (!pts.some((p) => series.some((s) => p[s.key] != null))) { box.textContent = "Sin datos todavía para este periodo."; return; }

  const W = Math.max(300, box.clientWidth), H = 240, L = 40, R = 12, T = 10, B = 24;
  const max = Math.max(1, ...pts.flatMap((p) => series.map((s) => p[s.key] || 0)));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (pts.length === 1 ? 0 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label + ". Usa las flechas para recorrer los días.");
  svg.setAttribute("tabindex", "0");
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4;
    add("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" });
    add("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, nf.format(Math.round(v)));
  }
  const every = Math.max(1, Math.ceil(pts.length / Math.floor((W - L - R) / 70)));
  pts.forEach((p, i) => {
    if (i % every === 0 || i === pts.length - 1) {
      add("text", { x: x(i), y: H - 6, "text-anchor": i === pts.length - 1 ? "end" : "middle" }, shortDate(p.date));
    }
  });
  const css = getComputedStyle(document.documentElement);
  for (const s of series) {
    let d = "", open = false;
    pts.forEach((p, i) => {
      if (p[s.key] == null) { open = false; return; }
      d += (open ? "L" : "M") + x(i).toFixed(1) + " " + y(p[s.key]).toFixed(1);
      open = true;
    });
    if (d) add("path", { d, fill: "none", stroke: css.getPropertyValue(s.color).trim(), "stroke-width": 2, "stroke-linejoin": "round", "stroke-dasharray": s.dash });
  }
  const cursor = add("line", { x1: 0, x2: 0, y1: T, y2: H - B, class: "cursor", visibility: "hidden" });
  box.append(svg);

  const tip = el("div", "tip");
  tip.hidden = true;
  tip.setAttribute("aria-live", "polite");
  box.append(tip);
  let at = pts.length - 1;
  const show = (i) => {
    at = i;
    const p = pts[i];
    tip.textContent = shortDate(p.date) + " · " + series.map((s) => s.label + " " + int(p[s.key])).join(" · ");
    tip.hidden = false;
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); cursor.setAttribute("visibility", "visible");
    const rect = svg.getBoundingClientRect();
    const left = (x(i) / W) * rect.width;
    tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), Math.max(0, rect.width - tip.offsetWidth)) + "px";
  };
  const hide = () => { tip.hidden = true; cursor.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    show(Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - R)) * (pts.length - 1)))));
  });
  svg.addEventListener("pointerleave", () => { if (document.activeElement !== svg) hide(); });
  svg.addEventListener("focus", () => show(at));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(ev.key in moves)) return;
    ev.preventDefault();
    show(Math.max(0, Math.min(pts.length - 1, at + moves[ev.key])));
  });
}

// ---------------------------------------------------------------- section bar

// The chip of the section in view is marked as the page scrolls.
const jumpLinks = [...document.querySelectorAll("#jump a")];
const watched = jumpLinks.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
if ("IntersectionObserver" in window) {
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target.id, e.isIntersecting);
    const first = watched.find((t) => seen.get(t.id));
    if (!first) return;
    for (const a of jumpLinks) {
      const on = a.getAttribute("href") === "#" + first.id;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current");
    }
  }, { rootMargin: "-130px 0px -55% 0px" });
  watched.forEach((t) => io.observe(t));
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (last) render(last); }, 150);
});
