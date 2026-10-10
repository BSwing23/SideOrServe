/* =========================================================
   Side or Serve — venue on-air numbers (announcer link required)
   ---------------------------------------------------------
   Feeds the live board's "On-Air Numbers". Aggregates every completed set
   scored at one venue (all accounts) inside a time window and returns only
   counts and percentages — no names, emails, ids or per-set records.

   These numbers are NOT public. A caller needs either a valid announcer key
   (?key=..., created by the admin in the app; only its SHA-256 hash is stored in
   announcerKeys/{hash}) or the admin's own sign-in. Anyone else gets 403.
   ========================================================= */

const admin = require("firebase-admin");
const crypto = require("crypto");
const { init, ADMIN_EMAIL } = require("./lib/access");
const TEST_VENUES = require("./lib/testVenues");

const THIN_N = 10;
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east",
                   northeast: "southwest", southwest: "northeast", northwest: "southeast", southeast: "northwest" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

/* Pure aggregation (exported for testing). `sets` are plain objects with
   createdAtMs, complete, includedInStats, mirroredFromSetId, gameType,
   ourScore, theirScore, completedSegments, servingTeamWon, matchId, venueId. */
function computeVenueInsights(sets, sinceMs) {
  const used = sets.filter((d) =>
    d.complete && d.includedInStats !== false && !d.mirroredFromSetId &&
    !TEST_VENUES.includes(d.venueId) &&
    typeof d.ourScore === "number" && typeof d.theirScore === "number" && d.ourScore !== d.theirScore &&
    (d.createdAtMs || 0) >= sinceMs);

  const matches = new Set(used.map((d) => d.matchId).filter(Boolean));

  // Side shares: the team standing on a side scored `ourPoints` while it was on seg.side,
  // and the opponents (on the opposite side) scored `theirPoints`.
  const pairs = {};
  used.forEach((d) => {
    (Array.isArray(d.completedSegments) ? d.completedSegments : []).forEach((s) => {
      const side = String(s.side || "").toLowerCase();
      const opp = OPPOSITE[side];
      if (!opp) return;
      const key = [side, opp].sort().join("|");
      const p = (pairs[key] = pairs[key] || { a: key.split("|")[0], b: key.split("|")[1], ptsA: 0, ptsB: 0, n: 0 });
      const our = s.ourPoints || 0, their = s.theirPoints || 0;
      if (side === p.a) { p.ptsA += our; p.ptsB += their; } else { p.ptsB += our; p.ptsA += their; }
      p.n++;
    });
  });
  const sides = Object.values(pairs).filter((p) => p.ptsA + p.ptsB > 0).map((p) => {
    const total = p.ptsA + p.ptsB;
    const shareA = (p.ptsA / total) * 100, shareB = 100 - shareA;
    const leader = shareA >= shareB ? p.a : p.b;
    return { pair: [cap(p.a), cap(p.b)], shares: { [cap(p.a)]: shareA, [cap(p.b)]: shareB },
             leader: cap(leader), edge: Math.abs(shareA - shareB), n: p.n, thin: p.n < THIN_N };
  }).sort((x, y) => y.n - x.n);

  // First-serving team win rate (precomputed per set)
  const sf = used.filter((d) => typeof d.servingTeamWon === "boolean");
  const serveFirst = { n: sf.length, won: sf.filter((d) => d.servingTeamWon).length };
  serveFirst.pct = serveFirst.n ? (serveFirst.won / serveFirst.n) * 100 : null;

  // Team ahead at the first switch (first segment must be a full, non-final segment)
  let fsN = 0, fsWon = 0;
  used.forEach((d) => {
    const interval = d.gameType === "deciding" ? 5 : 7;
    const s = (d.completedSegments || [])[0];
    if (!s || s.isPartial) return;
    if ((s.ourPoints || 0) + (s.theirPoints || 0) !== interval) return;
    if (s.ourPoints === s.theirPoints) return;
    fsN++;
    if ((s.ourPoints > s.theirPoints) === (d.ourScore > d.theirScore)) fsWon++;
  });
  const firstSwitch = { n: fsN, leaderWon: fsWon, pct: fsN ? (fsWon / fsN) * 100 : null };

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const t21 = used.filter((d) => d.gameType !== "deciding").map((d) => d.ourScore + d.theirScore);
  const t15 = used.filter((d) => d.gameType === "deciding").map((d) => d.ourScore + d.theirScore);
  const within2 = used.filter((d) => Math.abs(d.ourScore - d.theirScore) <= 2).length;

  return {
    sets: used.length,
    matches: matches.size,
    sides,
    serveFirst,
    firstSwitch,
    avgPoints: { "21": avg(t21), n21: t21.length, "15": avg(t15), n15: t15.length },
    closeSets: { n: used.length, within2, pct: used.length ? (within2 / used.length) * 100 : null },
  };
}

exports.computeVenueInsights = computeVenueInsights;

/* Is this request allowed to see the numbers for `venue`? */
async function isAuthorized(event, venue) {
  const qs = event.queryStringParameters || {};
  const key = String(qs.key || "");
  if (key && key.length <= 128) {
    try {
      const hash = crypto.createHash("sha256").update(key).digest("hex");
      const snap = await admin.firestore().collection("announcerKeys").doc(hash).get();
      if (snap.exists) {
        const d = snap.data();
        const expired = d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now();
        const venues = Array.isArray(d.venues) ? d.venues : [];
        if (!d.revoked && !expired && (venues.includes("*") || venues.includes(venue))) return true;
      }
    } catch (e) { console.error("announcer key check failed:", e.message); }
  }
  const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || "";
  if (header) {
    try {
      const caller = await admin.auth().verifyIdToken(header.replace(/^Bearer\s+/i, ""));
      if ((caller.email || "").toLowerCase() === ADMIN_EMAIL) return true;
    } catch (e) { /* not a valid sign-in */ }
  }
  return false;
}
exports.isAuthorized = isAuthorized;

exports.handler = async (event) => {
  const venue = String((event.queryStringParameters || {}).venue || "");
  if (!/^[a-z0-9-]{1,60}$/.test(venue) || TEST_VENUES.includes(venue)) return json(400, { error: "Bad venue" });
  const since = Math.max(0, parseInt((event.queryStringParameters || {}).since, 10) || 0);

  try { init(); } catch (e) {
    console.error("Firebase init failed:", e.message);
    return json(500, { error: "Server not configured" });
  }

  if (!(await isAuthorized(event, venue))) {
    return { statusCode: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Announcer link required" }) };
  }

  const snap = await admin.firestore().collection("sets").where("venueId", "==", venue)
    .select("complete", "includedInStats", "mirroredFromSetId", "gameType", "ourScore", "theirScore",
            "completedSegments", "servingTeamWon", "matchId", "venueId", "createdAt")
    .get();
  const sets = snap.docs.map((d) => {
    const x = d.data();
    return { ...x, createdAtMs: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0 };
  });
  return json(200, { venueId: venue, generatedAt: new Date().toISOString(), ...computeVenueInsights(sets, since) });
};
