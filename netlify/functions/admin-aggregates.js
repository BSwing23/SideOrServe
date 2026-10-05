/* =========================================================
   Side or Serve — admin-only aggregate stats across all users
   ---------------------------------------------------------
   Reads every set with the Admin SDK and returns ONLY anonymous aggregate
   numbers (counts and win rates) — no names, emails, user ids or per-set
   records ever leave this function. Callable only by the admin account.
   ========================================================= */

const admin = require("firebase-admin");

const ADMIN_EMAIL = "brian.scott.swingle@gmail.com";
const THIN_N = 10; // below this a bucket is flagged as thin data

function init() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

/* Pure aggregation over plain set objects (exported for testing).
   Each element: { userId, matchId, venueId, gameType, complete, includedInStats,
                   mirroredFromSetId, ourScore, theirScore, completedSegments[] } */
function computeAggregates(sets) {
  const used = [];
  const accounts = new Set();
  const matches = new Set();

  sets.forEach((d) => {
    if (!d.complete) return;
    if (d.includedInStats === false) return;
    if (d.venueId === "test-beach") return;       // test venue never counts
    if (d.mirroredFromSetId) return;              // partner mirror of a set already counted
    if (typeof d.ourScore !== "number" || typeof d.theirScore !== "number") return;
    if (d.ourScore === d.theirScore) return;
    used.push(d);
    if (d.userId) accounts.add(d.userId);
    if (d.matchId) matches.add(d.matchId);
  });

  const byType = { "21": 0, "15": 0 };
  // table[type][switchNumber][score] = { n, leaderWon }
  const table = { "21": {}, "15": {} };
  const ties = { "21": {}, "15": {} };

  used.forEach((d) => {
    const type = d.gameType === "deciding" ? "15" : "21";
    const interval = type === "15" ? 5 : 7;
    byType[type]++;
    const weWon = d.ourScore > d.theirScore;
    const segs = Array.isArray(d.completedSegments) ? d.completedSegments : [];
    let our = 0, their = 0;
    for (let k = 1; k <= segs.length; k++) {
      const s = segs[k - 1];
      const total = (s.ourPoints || 0) + (s.theirPoints || 0);
      // The last segment of a set is flagged isPartial even when it happens to hold a
      // full 7 (or 5) points; the set ended there, so no switch followed. Not a switch.
      if (s.isPartial || total !== interval) break;
      our += s.ourPoints || 0;
      their += s.theirPoints || 0;
      const bucket = (table[type][k] = table[type][k] || {});
      if (our === their) {
        ties[type][k] = (ties[type][k] || 0) + 1;
        continue;
      }
      const leaderIsUs = our > their;
      const key = Math.max(our, their) + "-" + Math.min(our, their);
      const cell = (bucket[key] = bucket[key] || { n: 0, leaderWon: 0 });
      cell.n++;
      if (leaderIsUs === weWon) cell.leaderWon++;
    }
  });

  const out = {};
  ["21", "15"].forEach((type) => {
    out[type] = Object.keys(table[type]).map(Number).sort((a, b) => a - b).map((k) => {
      const rows = Object.entries(table[type][k]).map(([score, c]) => {
        const [l, t] = score.split("-").map(Number);
        return { score, margin: l - t, n: c.n, leaderWon: c.leaderWon,
                 pct: c.n ? Math.round((c.leaderWon / c.n) * 1000) / 10 : null, thin: c.n < THIN_N };
      }).sort((a, b) => a.margin - b.margin || b.n - a.n);
      const margins = {};
      rows.forEach((r) => {
        const m = (margins[r.margin] = margins[r.margin] || { margin: r.margin, n: 0, leaderWon: 0 });
        m.n += r.n; m.leaderWon += r.leaderWon;
      });
      const byMargin = Object.values(margins).sort((a, b) => a.margin - b.margin).map((m) => ({
        ...m, pct: Math.round((m.leaderWon / m.n) * 1000) / 10, thin: m.n < THIN_N,
      }));
      return { switchNumber: k, atTotalPoints: k * (type === "15" ? 5 : 7), rows, byMargin, tied: ties[type][k] || 0 };
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    overview: { sets: used.length, matches: matches.size, accounts: accounts.size, byType },
    switches: out,
  };
}

exports.computeAggregates = computeAggregates;

exports.handler = async (event) => {
  try { init(); } catch (e) {
    console.error("Firebase init failed:", e.message);
    return json(500, { error: "Server not configured" });
  }

  const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || "";
  let caller;
  try {
    caller = await admin.auth().verifyIdToken(header.replace(/^Bearer\s+/i, ""));
  } catch (e) {
    return json(401, { error: "Sign in required" });
  }
  if (!caller.email || caller.email.toLowerCase() !== ADMIN_EMAIL || caller.email_verified !== true) {
    return json(403, { error: "Admin only" });
  }

  const snap = await admin.firestore().collection("sets")
    .select("userId", "matchId", "venueId", "gameType", "complete", "includedInStats",
            "mirroredFromSetId", "ourScore", "theirScore", "completedSegments")
    .get();
  return json(200, computeAggregates(snap.docs.map((d) => d.data())));
};
