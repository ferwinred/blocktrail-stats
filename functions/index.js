// The one backend of the stats page: a callable function that checks who is
// asking, reads every source in parallel and keeps each answer for a while in
// Firestore so opening the page often does not burn API quota.
//
// Who may read: the e-mails listed in Firestore at config/statsAccess, field
// "emails". Edit that list in the Firebase console; no redeploy needed.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
const TTL = { realtime: 1, analytics: 10, admob: 30, unity: 30, playVitals: 360, playReports: 360 };

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
    if (!token.email_verified || !(await allowed(token.email))) {
      throw new HttpsError("permission-denied", "Tu cuenta no tiene acceso. Pide que añadan " + (token.email || "tu correo") + " a la lista.");
    }

    const only = (request.data && request.data.only) || null;
    const force = !!(request.data && request.data.force);
    const want = (name) => !only || only.includes(name);

    const oauth = new OAuth2Client(OAUTH_CLIENT_ID.value(), OAUTH_CLIENT_SECRET.value());
    oauth.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN.value() });
    let google;
    try {
      google = (await oauth.getAccessToken()).token;
    } catch (err) {
      throw new HttpsError("failed-precondition", "La autorización de Google caducó o fue revocada: hay que renovar STATS_OAUTH_REFRESH_TOKEN.");
    }

    const jobs = {
      realtime: () => sources.realtime(google, GA4_PROPERTY.value()),
      analytics: () => sources.analytics(google, GA4_PROPERTY.value()),
      playVitals: () => sources.playVitals(google),
      playReports: () => sources.playReports(google, PLAY_BUCKET.value()),
      admob: () => sources.admob(google, ADMOB_APP_ID.value()),
      unity: () => {
        if (!UNITY_ORG_ID.value()) throw new Error("Falta UNITY_ORG_ID: el id de organización de Unity.");
        return sources.unity(UNITY_API_KEY.value(), UNITY_ORG_ID.value(), UNITY_GAME_ID.value());
      },
    };

    const names = Object.keys(jobs).filter(want);
    const results = await Promise.all(names.map((n) => cached(n, TTL[n], force, jobs[n])));
    return { generated: Date.now(), sources: Object.fromEntries(names.map((n, i) => [n, results[i]])) };
  },
);
