import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const stats = httpsCallable(getFunctions(app, "us-central1"), "stats", { timeout: 70000 });

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("es-CO");
const n1 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const usd = new Intl.NumberFormat("es-CO", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v == null ? "—" : n1.format(v * 100) + " %");
const int = (v) => (v == null ? "—" : nf.format(v));

const EVENT_LABELS = {
  first_open: "Instalaciones (primera apertura)", app_remove: "Desinstalaciones", session_start: "Sesiones",
  level_start: "Niveles empezados", level_complete: "Niveles ganados", level_fail: "Niveles perdidos",
  level_continue: "Continuar tras perder", daily_reward_claim: "Recompensa diaria", daily_challenge_start: "Reto del día empezado",
  daily_challenge_complete: "Reto del día ganado", zen_start: "Partidas de modo clásico", zen_end: "Modo clásico terminado",
  shop_view: "Visitas a la tienda", shop_purchase: "Compras en la tienda", in_app_purchase: "Compras con dinero",
  world_purchased: "Mundos comprados con gemas", world_unlocked: "Mundos abiertos por jefe", booster_used: "Potenciadores usados",
  ad_requested: "Anuncios pedidos", ad_shown: "Anuncios mostrados", ad_reward_granted: "Recompensas por anuncio",
  ad_impression: "Impresiones con ingreso", review_prompt: "Petición de reseña", push_setting: "Cambios de notificaciones",
  run_resume: "Partida retomada", mission_complete: "Misiones completadas", win_streak_reward: "Premio por racha de victorias",
};
const FORMATS = { interstitial: "Intersticial", rewarded: "Recompensa", rewarded_interstitial: "Bonificado intersticial", banner: "Banner", app_open: "Apertura" };

let last = null;
let realtimeTimer = null;

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

async function load({ only = null, force = false }) {
  $("status").textContent = only ? $("status").textContent : "Cargando…";
  $("refresh").disabled = true;
  try {
    const res = await stats({ only, force });
    last = only && last ? { ...last, sources: { ...last.sources, ...res.data.sources } } : res.data;
    render(last);
  } catch (err) {
    if (err.code === "functions/permission-denied" || err.code === "functions/unauthenticated") {
      await signOut(auth);
      showLoginError(err.message);
      return;
    }
    $("status").textContent = "No se pudieron cargar las estadísticas: " + (err.message || err);
  } finally {
    $("refresh").disabled = false;
  }
}

// ---------------------------------------------------------------- render

function source(data, name) {
  const s = (data.sources || {})[name];
  const el = $("err-" + name);
  if (el) {
    el.hidden = !s || s.ok;
    if (s && !s.ok) {
      el.textContent = (s.stale ? "Mostrando el último dato bueno (" + when(s.at) + "). " : "") + nameOf(name) + " falló: " + s.error;
    }
  }
  return s && s.data ? s.data : null;
}

const nameOf = (n) => ({ realtime: "El tiempo real", analytics: "Google Analytics", admob: "AdMob", unity: "Unity Ads", playReports: "Los informes de Play", playVitals: "Android vitals" }[n] || n);
const when = (ms) => (ms ? new Date(ms).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—");

function setDelta(id, now, before, goodWhenUp = true) {
  const el = $(id);
  if (!el) return;
  el.className = "delta";
  if (now == null || before == null || before === 0) { el.textContent = before === 0 && now ? "nuevo frente a la semana anterior" : ""; return; }
  const change = (now - before) / before;
  const good = change === 0 ? null : (change > 0) === goodWhenUp;
  el.textContent = (change > 0 ? "+" : change < 0 ? "−" : "±") + n1.format(Math.abs(change) * 100) + " % frente a la semana anterior";
  if (good !== null) el.classList.add(good ? "up" : "down");
}

function render(data) {
  const sources = data.sources || {};
  const newest = Math.max(...Object.values(sources).map((s) => s.at || 0));
  $("status").textContent = "Actualizado " + when(newest) + ". Las cifras de cada fuente se reutilizan unos minutos para no agotar sus cuotas.";

  const rt = source(data, "realtime");
  if (rt) {
    $("rt-active").textContent = int(rt.activeUsers);
    $("rt-installs").textContent = int(rt.events.first_open || 0);
    $("rt-levels").textContent = int(rt.events.level_complete || 0) + " / " + int(rt.events.level_fail || 0);
    $("rt-ads").textContent = int(rt.events.ad_impression || 0);
    $("rt-countries").textContent = rt.countries.length
      ? "Por país: " + rt.countries.map((c) => c.country + " " + c.activeUsers).join(" · ") : "Nadie jugando en este momento.";
  }

  const ga = source(data, "analytics");
  if (ga) renderAnalytics(ga);

  const admob = source(data, "admob");
  if (admob) renderAdmob(admob);

  const un = source(data, "unity");
  if (un) {
    const recent = un.rows.slice(-7);
    $("un-rev").textContent = usd.format(recent.reduce((a, r) => a + r.revenue, 0));
    $("un-views").textContent = int(recent.reduce((a, r) => a + r.views, 0)) + " anuncios vistos";
  }

  const play = source(data, "playReports");
  if (play) renderPlay(play);
  const vitals = source(data, "playVitals");
  if (vitals) {
    const lastCrash = vitals.crash.at(-1);
    $("pl-rate").textContent = lastCrash ? pct(lastCrash.userPerceivedCrashRate) : "Sin datos";
    $("pl-rate-n").textContent = lastCrash ? "percibida, " + lastCrash.date + " · límite de Play 1,09 %" : "Play la publica con más usuarios diarios";
  }

  drawChart(ga ? ga.daily : [], play ? play.installs : []);
}

function renderAnalytics(ga) {
  const a = ga.totals.last7, p = ga.totals.prev7;
  $("testers-note").textContent = ga.excludeTesters
    ? "Sin testers: las cifras son solo de jugadores reales."
    : "Incluye a los testers: Analytics todavía no reconoce su marca.";
  $("ga-active").textContent = int(a.activeUsers);
  setDelta("ga-active-d", a.activeUsers, p.activeUsers);
  $("ga-new").textContent = int(a.newUsers);
  setDelta("ga-new-d", a.newUsers, p.newUsers);
  const mins = (t) => (t.activeUsers ? t.userEngagementDuration / 60 / t.activeUsers : null);
  $("ga-min").textContent = mins(a) == null ? "—" : n1.format(mins(a));
  setDelta("ga-min-d", mins(a), mins(p));
  const ev = ga.events;
  const won = (ev.level_complete || {}).count7 || 0, lost = (ev.level_fail || {}).count7 || 0;
  $("ga-win").textContent = won + lost ? pct(won / (won + lost)) : "—";
  $("ga-d1").textContent = pct(ga.retention.d1.rate);
  $("ga-d1-n").textContent = "de " + int(ga.retention.d1.users) + " instalaciones";
  $("ga-d7").textContent = pct(ga.retention.d7.rate);
  $("ga-d7-n").textContent = "de " + int(ga.retention.d7.users) + " instalaciones";
  $("ga-buy").textContent = usd.format(a.purchaseRevenue || 0);
  $("ga-buyers").textContent = int(a.totalPurchasers || 0) + " compradores";

  fill("t-countries", ga.countries.map((c) => [c.country, int(c.activeUsers), int(c.newUsers), c.activeUsers ? n1.format(c.userEngagementDuration / 60 / c.activeUsers) : "—"]));
  fill("t-versions", ga.versions.map((v) => [v.appVersion, int(v.activeUsers)]));
  fill("t-events", Object.entries(ev).sort((x, y) => y[1].count28 - x[1].count28)
    .map(([k, v]) => [EVENT_LABELS[k] || k, int(v.count7), int(v.users7), int(v.count28)]));
}

function renderAdmob(admob) {
  const days = [...new Set(admob.rows.map((r) => r.date))].sort().slice(-7);
  const recent = admob.rows.filter((r) => days.includes(r.date));
  const sum = (k, rows = recent) => rows.reduce((a, r) => a + r[k], 0);
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
  const inst = play.installs.slice(-7);
  $("pl-inst").textContent = int(inst.reduce((a, r) => a + (r.userInstalls || 0), 0));
  $("pl-inst-n").textContent = inst.length ? "7 días hasta el " + inst.at(-1).date : "";
  $("pl-uninst").textContent = int(inst.reduce((a, r) => a + (r.userUninstalls || 0), 0));
  const lastDay = inst.length ? inst.at(-1).date : null;
  const days = new Set(inst.map((r) => r.date));
  const crashes = play.crashes.filter((r) => days.has(r.date));
  $("pl-crash").textContent = lastDay ? int(crashes.reduce((a, r) => a + r.crashes + r.anrs, 0)) : "—";
}

function fill(id, rows) {
  const body = document.querySelector("#" + id + " tbody");
  body.replaceChildren(...rows.map((cells) => {
    const tr = document.createElement("tr");
    for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.append(td); }
    return tr;
  }));
}

// ---------------------------------------------------------------- chart

function drawChart(daily, installs) {
  const box = $("chart");
  box.replaceChildren();
  const byDate = new Map();
  for (const d of daily) {
    const key = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6)}`;
    byDate.set(key, { date: key, a: d.activeUsers, n: d.newUsers });
  }
  for (const r of installs) {
    if (!byDate.has(r.date)) continue;
    byDate.get(r.date).p = r.userInstalls;
  }
  const pts = [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  if (!pts.length) { box.textContent = "Sin datos de Analytics todavía."; return; }

  const W = Math.max(300, box.clientWidth), H = 240, L = 34, R = 12, T = 10, B = 24;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.a, p.n, p.p || 0)));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (pts.length === 1 ? 0 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Jugadores activos, nuevos e instalaciones de Play por día");
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4;
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" });
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, nf.format(Math.round(v)));
  }
  const every = Math.max(1, Math.ceil(pts.length / Math.floor((W - L - R) / 70)));
  pts.forEach((p, i) => {
    if (i % every === 0 || i === pts.length - 1) {
      el("text", { x: x(i), y: H - 6, "text-anchor": i === pts.length - 1 ? "end" : "middle" }, p.date.slice(8) + "/" + p.date.slice(5, 7));
    }
  });
  const css = getComputedStyle(document.documentElement);
  const series = [["a", "--accent"], ["n", "--gold"], ["p", "--play"]];
  for (const [key, color] of series) {
    let d = "", open = false;
    pts.forEach((p, i) => {
      if (p[key] == null) { open = false; return; }
      d += (open ? "L" : "M") + x(i).toFixed(1) + " " + y(p[key]).toFixed(1);
      open = true;
    });
    if (d) el("path", { d, fill: "none", stroke: css.getPropertyValue(color).trim(), "stroke-width": 2, "stroke-linejoin": "round" });
  }
  box.append(svg);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  box.append(tip);
  svg.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - R)) * (pts.length - 1))));
    const p = pts[i];
    tip.textContent = `${p.date.slice(8)}/${p.date.slice(5, 7)} · ${int(p.a)} activos · ${int(p.n)} nuevos` + (p.p != null ? ` · ${int(p.p)} en Play` : "");
    tip.hidden = false;
    const left = (x(i) / W) * rect.width;
    tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), rect.width - tip.offsetWidth) + "px";
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; });
}

window.addEventListener("resize", () => { if (last) drawChart((source(last, "analytics") || {}).daily || [], (source(last, "playReports") || {}).installs || []); });
