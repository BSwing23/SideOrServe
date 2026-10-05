/* =========================================================
   Side or Serve — scorekeeper access
   ---------------------------------------------------------
   A scorekeeper uses the app free of charge for as long as at least one
   person who invited them (and whose invitation they accepted) still has
   access — an active/trial subscription, a verified school email, comp, or
   admin. Firestore rules keep other users' subscription records private, so
   the check runs here with the Admin SDK and returns only { ok }.
   ========================================================= */

const admin = require("firebase-admin");
const { init, accountHasAccess } = require("./lib/access");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

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

  const db = admin.firestore();
  const invites = await db.collection("players").doc(caller.uid)
    .collection("scorekeeperInvites").where("status", "==", "accepted").get();

  for (const inv of invites.docs) {
    const ownerId = inv.id;
    // The owner must still have the link in place (they may have removed this scorekeeper).
    const link = await db.collection("players").doc(ownerId).collection("scorekeepers").doc(caller.uid).get();
    if (!link.exists) continue;
    if ((await accountHasAccess(ownerId)).ok) return json(200, { ok: true });
  }
  return json(200, { ok: false });
};
