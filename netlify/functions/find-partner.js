/* =========================================================
   Side or Serve — partner lookup
   ---------------------------------------------------------
   Partner pairing needs to find another user by exact email. The Firestore
   rules keep every profile private to its owner, so the lookup runs here with
   the Admin SDK instead. Requires a valid Firebase sign-in, matches the exact
   email only, and returns just the uid, display name and — for partner
   lookups — whether that person has an active subscription / free access
   (a partner must be a subscriber to share data).
   ========================================================= */

const admin = require("firebase-admin");
const { init, accountHasAccess } = require("./lib/access");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  try { init(); } catch (e) {
    console.error("Firebase init failed:", e.message);
    return json(500, { error: "Server not configured" });
  }

  const header = (event.headers || {}).authorization || (event.headers || {}).Authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  let caller;
  try {
    caller = await admin.auth().verifyIdToken(token);
  } catch (e) {
    return json(401, { error: "Sign in required" });
  }

  let email, purpose;
  try {
    const body = JSON.parse(event.body || "{}");
    email = String(body.email || "").trim().toLowerCase();
    purpose = body.purpose === "scorekeeper" ? "scorekeeper" : "partner";
  } catch (e) {
    return json(400, { error: "Bad request" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Enter a valid email" });

  const snap = await admin.firestore().collection("players").where("email", "==", email).limit(5).get();
  const users = [];
  for (const d of snap.docs) {
    if (d.id === caller.uid) continue;
    const user = { uid: d.id, name: d.data().name || "User", email };
    // Scorekeepers don't need their own subscription; partners do.
    if (purpose === "partner") user.hasAccess = (await accountHasAccess(d.id)).ok;
    users.push(user);
  }
  return json(200, { users });
};
