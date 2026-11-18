// The one backend of the stats page: a callable function that checks who is
// asking, reads every source in parallel and keeps each answer for a while in
// Firestore so opening the page often does not burn API quota.
//
// Who may read: the e-mails listed in Firestore at config/statsAccess, field
// "emails" (edit it in the Firebase console; no redeploy needed), and anyone
// with a role in the content dashboard (the custom claim "role"). Revenue is
// for the list and for publishers and owners; viewers and editors get the rest.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { OAuth2Client } = require("google-auth-library");
const sources = require("./sources");

initializeApp();
const db = getFirestore();

const OAUTH_CLIENT_ID = defineSecret("STATS_OAUTH_CLIENT_ID");
const OAUTH_CLIENT_SECRET = defineSecret("STATS_OAUTH_CLIENT_SECRET");
const OAUTH_REFRESH_TOKEN = defineSecret("STATS_OAUTH_REFRESH_TOKEN");
const UNITY_API_KEY = defineSecret("STATS_UNITY_API_KEY");

const GA4_PROPERTY = defineString("GA4_PROPERTY", { default: "542428799" });
const PLAY_BUCKET = defineString("PLAY_BUCKET", { default: "pubsite_prod_6750866361823103900" });
const ADMOB_APP_ID = defineString("ADMOB_APP_ID", { default: "ca-app-pub-9104124048191994~7609228329" });
const UNITY_ORG_ID = defineString("UNITY_ORG_ID", { default: "" });
const UNITY_GAME_ID = defineString("UNITY_GAME_ID", { default: "" });

/** Sources that are only about revenue: skipped for roles without access to it. */
const MONEY_SOURCES = ["admob", "unity"];

/** Analytics without the revenue figures, for viewers and editors. */
function withoutMoney(ga) {
  const strip = (o) => { if (!o) return o; const { purchaseRevenue, totalAdRevenue, ...rest } = o; return rest; };
  return {
    ...ga,
    totals: { cur: strip(ga.totals.cur), prev: strip(ga.totals.prev) },
    daily: (ga.daily || []).map(strip),
    campaigns: ga.campaigns && ga.campaigns.map(({ revenue, adRevenue, ...rest }) => rest),
    countryValue: null,
  };
}

/** No source may hold the page: past this it fails alone and the rest still arrive. */
const SOURCE_DEADLINE_MS = 20000;

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("No respondió en " + ms / 1000 + " s.")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** How long each answer is reused, in minutes. Play is days behind anyway. */
const TTL = { realtime: 1, analytics: 10, retention: 60, experiment: 30, admob: 30, unity: 30, playVitals: 360, playReports: 360 };

async function allowed(email) {
  if (!email) return false;
  const doc = await db.doc("config/statsAccess").get();
  const list = (doc.exists ? doc.get("emails") || [] : []).map((e) => String(e).trim().toLowerCase());
  return list.includes(email.toLowerCase());
}

async function cached(key, minutes, force, load) {
  const ref = db.doc("statsCache/" + key);
  if (!force) {
    const snap = await ref.get();
    if (snap.exists && Date.now() - snap.get("at") < minutes * 60000) {
      return { ok: true, at: snap.get("at"), cached: true, data: JSON.parse(snap.get("json")) };
    }
  }
  try {
    const data = await withDeadline(load(), SOURCE_DEADLINE_MS);
    const at = Date.now();
    await ref.set({ at, json: JSON.stringify(data) });
    return { ok: true, at, cached: false, data };
  } catch (err) {
    // A failing source keeps its last good answer, marked as old.
    const snap = await ref.get();
    const stale = snap.exists ? { at: snap.get("at"), data: JSON.parse(snap.get("json")) } : {};
    return { ok: false, error: String(err.message || err).slice(0, 400), stale: !!snap.exists, ...stale };
  }
}

exports.stats = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 90,
    memory: "256MiB",
    maxInstances: 2,
    secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN, UNITY_API_KEY],
  },
  async (request) => {
    const token = request.auth && request.auth.token;
    if (!token) throw new HttpsError("unauthenticated", "Inicia sesión para ver las estadísticas.");
    const rank = { viewer: 1, editor: 2, publisher: 3, owner: 4 }[token.role] || 0;
    const listed = !!token.email_verified && (await allowed(token.email));
    if (!token.email_verified || (!listed && rank === 0)) {
      throw new HttpsError("permission-denied", "Tu cuenta no tiene acceso. Pide que añadan " + (token.email || "tu correo") + " a la lista.");
    }
    const money = listed || rank >= 3;

    const asked = request.data && request.data.only;
    const only = Array.isArray(asked) ? asked.filter((n) => typeof n === "string") : null;
    const force = !!(request.data && request.data.force);
    const asked_period = Number(request.data && request.data.period);
    const period = sources.PERIODS.includes(asked_period) ? asked_period : 7;
    // The experiment is only measured when asked for, with versions and a start date.
    const ex = request.data && request.data.experiment;
    const exp = ex && Number.isInteger(ex.control) && Number.isInteger(ex.variant) && /^\d{4}-\d{2}-\d{2}$/.test(String(ex.since))
      ? { control: ex.control, variant: ex.variant, since: String(ex.since) } : null;
    // Without revenue rights the money sources are not even asked.
    const want = (name) => (!only || only.includes(name)) && (money || !MONEY_SOURCES.includes(name));

    // The Google token is asked once, when the first Google source needs it. If
    // Google refuses it, only those sources fail (each keeps its last good data):
    // Unity, which does not use Google, still answers.
    let tokenPromise = null;
    const google = () => (tokenPromise ||= (async () => {
      // Trimmed: a value pasted at a prompt easily carries a space or a line break.
      const oauth = new OAuth2Client(OAUTH_CLIENT_ID.value().trim(), OAUTH_CLIENT_SECRET.value().trim());
      oauth.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN.value().trim() });
      try {
        return (await oauth.getAccessToken()).token;
      } catch (err) {
        // Google says which part it refused: invalid_client is the id or secret, invalid_grant the refresh token.
        const reason = String((err.response && err.response.data && err.response.data.error) || err.message || err);
        console.error("OAuth token exchange failed:", reason);
        throw new Error(reason.includes("invalid_client")
          ? "Google rechazó el cliente OAuth: revisa STATS_OAUTH_CLIENT_ID y STATS_OAUTH_CLIENT_SECRET."
          : "La autorización de Google caducó o fue revocada (" + reason + "): hay que renovar STATS_OAUTH_REFRESH_TOKEN.");
      }
    })());

    const jobs = {
      realtime: async () => sources.realtime(await google(), GA4_PROPERTY.value()),
      analytics: async () => sources.analytics(await google(), GA4_PROPERTY.value(), period),
      retention: async () => sources.retention(await google(), GA4_PROPERTY.value()),
      experiment: async () => {
        if (!exp) throw new Error("Falta el experimento: versiones y fecha de inicio.");
        return sources.experiment(await google(), GA4_PROPERTY.value(), exp);
      },
      playVitals: async () => sources.playVitals(await google()),
      playReports: async () => sources.playReports(await google(), PLAY_BUCKET.value()),
      admob: async () => sources.admob(await google(), ADMOB_APP_ID.value()),
      unity: () => {
        if (!UNITY_ORG_ID.value()) throw new Error("Falta UNITY_ORG_ID: el id de organización de Unity.");
        return sources.unity(UNITY_API_KEY.value().trim(), UNITY_ORG_ID.value(), UNITY_GAME_ID.value());
      },
    };

    // The experiment is never part of a full load: only asked for by name.
    const names = Object.keys(jobs).filter((n) => want(n) && (n !== "experiment" || (only && only.includes(n))));
    // Analytics depends on the period, so each period keeps its own cached answer.
    const key = (n) => (n === "analytics" ? n + "_" + period : n === "experiment" && exp ? `experiment_${exp.control}_${exp.variant}_${exp.since}` : n);
    const results = await Promise.all(names.map((n) => cached(key(n), TTL[n], force, jobs[n])));
    const out = Object.fromEntries(names.map((n, i) => [n, results[i]]));
    if (!money && out.analytics && out.analytics.data) out.analytics = { ...out.analytics, data: withoutMoney(out.analytics.data) };
    if (!money && out.experiment && out.experiment.data)
      out.experiment = { ...out.experiment, data: { ...out.experiment.data,
        groups: out.experiment.data.groups.map(({ purchaseRevenue, adRevenue, ...g }) => g) } };
    return { generated: Date.now(), period, money, sources: out };
  },
);

/**
 * Once a day, after Analytics' daily export: rebuilds the aggregates in
 * BigQuery (warehouse.js). Waits quietly until the export is linked.
 */
exports.statsWarehouse = onSchedule(
  { schedule: "every day 07:30", timeZone: "America/Bogota", region: "us-central1", timeoutSeconds: 540, memory: "256MiB" },
  async () => {
    const { buildAggregates } = require("./warehouse");
    const out = await buildAggregates(GA4_PROPERTY.value());
    console.log("statsWarehouse", JSON.stringify(out));
  },
);
