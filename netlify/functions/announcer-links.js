/* =========================================================
   Side or Serve — announcer links (admin only)
   ---------------------------------------------------------
   Creates, lists and revokes the private keys that unlock a venue's On-Air
   Numbers (see venue-insights.js). Only the admin account may call this.
   The key itself is shown once, at creation; Firestore keeps only its SHA-256
   hash in announcerKeys/{hash}, a collection no client rule exposes.
   ========================================================= */

const admin = require("firebase-admin");
const crypto = require("crypto");
const { init, ADMIN_EMAIL } = require("./lib/access");

const SITE = "https://sideorservevb.com";
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  try { init(); } catch (e) { return json(500, { error: "Server not configured" }); }

  const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || "";
  let caller;
  try { caller = await admin.auth().verifyIdToken(header.replace(/^Bearer\s+/i, "")); }
  catch (e) { return json(401, { error: "Sign in required" }); }
  if ((caller.email || "").toLowerCase() !== ADMIN_EMAIL) return json(403, { error: "Admin only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad request" }); }
  const col = admin.firestore().collection("announcerKeys");

  if (body.action === "create") {
    const venue = String(body.venue || "");
    if (venue !== "*" && !/^[a-z0-9-]{1,60}$/.test(venue)) return json(400, { error: "Pick a venue" });
    const days = Math.min(365, Math.max(1, parseInt(body.days, 10) || 3));
    const label = String(body.label || "").trim().slice(0, 80) || "Announcer";
    const key = crypto.randomBytes(18).toString("base64url");
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const expiresAt = new Date(Date.now() + days * 86400000);
    await col.doc(hash).set({
      label, venues: [venue], revoked: false, keyPrefix: key.slice(0, 4),
      createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt, createdBy: caller.uid,
    });
    const url = venue === "*" ? `${SITE}/live?key=${key}` : `${SITE}/live/${venue}?key=${key}`;
    return json(200, { url, label, venue, expiresAt: expiresAt.toISOString(), id: hash });
  }

  if (body.action === "list") {
    const snap = await col.get();
    const rows = snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id, label: x.label, venues: x.venues, revoked: !!x.revoked, keyPrefix: x.keyPrefix,
        createdAt: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0,
        expiresAt: x.expiresAt && x.expiresAt.toMillis ? x.expiresAt.toMillis() : 0,
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
    return json(200, { links: rows });
  }

  if (body.action === "revoke") {
    const id = String(body.id || "");
    if (!/^[a-f0-9]{64}$/.test(id)) return json(400, { error: "Bad id" });
    try { await col.doc(id).update({ revoked: true, revokedAt: admin.firestore.FieldValue.serverTimestamp() }); }
    catch (e) { return json(404, { error: "No such link" }); }
    return json(200, { ok: true });
  }

  return json(400, { error: "Unknown action" });
};
