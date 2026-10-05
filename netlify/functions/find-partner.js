/* =========================================================
   Side or Serve — partner lookup
   ---------------------------------------------------------
   Partner pairing needs to find another user by exact email. The Firestore
   rules keep every profile private to its owner, so the lookup runs here with
   the Admin SDK instead. Requires a valid Firebase sign-in, matches the exact
   email only, and returns just the uid and display name.
   ========================================================= */

const admin = require("firebase-admin");

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

  let email;
  try {
    email = String(JSON.parse(event.body || "{}").email || "").trim().toLowerCase();
  } catch (e) {
    return json(400, { error: "Bad request" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Enter a valid email" });

  const snap = await admin.firestore().collection("players").where("email", "==", email).limit(5).get();
  const users = snap.docs
    .filter((d) => d.id !== caller.uid)
    .map((d) => ({ uid: d.id, name: d.data().name || "User", email }));
  return json(200, { users });
};
