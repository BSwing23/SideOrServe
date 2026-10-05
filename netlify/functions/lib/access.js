/* Shared access check for server functions.
   Mirrors the client's checkAccess() in index.html — keep the two in sync
   (admin email, FREE_ACCESS_DOMAINS, and the subscription statuses). */

const admin = require("firebase-admin");

const ADMIN_EMAIL = "brian.scott.swingle@gmail.com";
const FREE_ACCESS_DOMAINS = ["arizona.edu", "lmu.edu", "stanford.edu"];

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

/* Does this account have access on its own (admin, verified school email,
   comp, or an active/trialing subscription)? Returns { ok, reason }. */
async function accountHasAccess(uid) {
  init();
  let user;
  try { user = await admin.auth().getUser(uid); } catch (e) { return { ok: false, reason: "no-account" }; }
  const email = (user.email || "").toLowerCase();
  if (email === ADMIN_EMAIL) return { ok: true, reason: "admin" };
  const domain = email.split("@")[1] || "";
  if (user.emailVerified && FREE_ACCESS_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) {
    return { ok: true, reason: "edu" };
  }
  const snap = await admin.firestore().collection("subscribers").doc(uid).get();
  const sub = snap.exists ? snap.data() : null;
  if (sub) {
    if (sub.comp === true) return { ok: true, reason: "comp" };
    if (["on_trial", "active", "past_due"].includes(sub.status)) return { ok: true, reason: "subscribed" };
    if (sub.status === "cancelled" && sub.ends_at && new Date(sub.ends_at) > new Date()) return { ok: true, reason: "subscribed" };
  }
  return { ok: false, reason: "no-subscription" };
}

module.exports = { init, accountHasAccess, ADMIN_EMAIL, FREE_ACCESS_DOMAINS };
