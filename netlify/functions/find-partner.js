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
  const add = async (uid, name) => {
    if (uid === caller.uid) return;
    const user = { uid, name: name || email.split("@")[0], email };
    // Scorekeepers don't need their own subscription; partners do.
    if (purpose === "partner") user.hasAccess = (await accountHasAccess(uid)).ok;
    users.push(user);
  };
  for (const d of snap.docs) await add(d.id, d.data().name || "User");

  // A new scorekeeper signs up and lands on the paywall before they can create a
  // profile, so there is no players doc to match yet. Fall back to the sign-in
  // account itself (also covers an email stored with different capitalisation).
  if (!users.length) {
    try {
      const authUser = await admin.auth().getUserByEmail(email);
      await add(authUser.uid, authUser.displayName);
    } catch (e) {
      if (e.code !== "auth/user-not-found") console.error("Auth lookup failed:", e.message);
    }
  }
  return json(200, { users });
};
