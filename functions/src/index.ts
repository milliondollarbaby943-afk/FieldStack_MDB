import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import cors from "cors";
import { checkUserRole, checkAdminRole } from "./authHelpers";
import { sendPasswordResetEmail as sendPasswordResetEmailViaResend, sendVerificationEmailToAddress } from "./emailService";
import type { Subscription, SubscriptionPlan } from "./types";
import { buildPriceIdToPlanMap, invalidatePlanCache } from "./plans";
import { buildPlanSeedData, PLAN_IDS } from "./seedPlans";
import { createLogger, logger } from "./logger";
import * as crypto from "crypto";
import Stripe from "stripe";
import { sanitizeString } from "./validation";
import { Timestamp } from "firebase-admin/firestore";

type StripeInstance = InstanceType<typeof Stripe>;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
let _stripe: StripeInstance | null = null;
function getStripe(): StripeInstance {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
  }
  return _stripe;
}

// When running under the Functions emulator, tell the Admin SDK to trust
// emulator-issued auth tokens. FIREBASE_AUTH_EMULATOR_HOST cannot be set via
// .env (reserved prefix), so we set it here before initializeApp().
if (process.env.FUNCTIONS_EMULATOR) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
}

admin.initializeApp();
const db = admin.firestore();
db.settings({
  ignoreUndefinedProperties: true,
  // preferRest causes the Admin SDK to use real Google OAuth credentials even
  // in the emulator, which breaks when those credentials expire (invalid_rapt).
  // Only enable it in production where it improves cold-start performance.
  ...(process.env.FUNCTIONS_EMULATOR ? {} : { preferRest: true }),
});

logger.info("[startup] env check", {
  CORS_ORIGIN: process.env.CORS_ORIGIN ? `set (${process.env.CORS_ORIGIN.split(",").length} origins)` : "MISSING",
  FRONTEND_URL: process.env.FRONTEND_URL ?? "MISSING",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? `set (${process.env.STRIPE_SECRET_KEY.slice(0, 7)}...)` : "MISSING",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? "set" : "MISSING",
  RESEND_API_KEY: process.env.RESEND_API_KEY ? "set" : "MISSING",
  APP_NAME: process.env.APP_NAME ?? "MISSING",
  APP_URL: process.env.APP_URL ?? "MISSING",
  FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR ?? "not set",
  FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "not set",
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const rawCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

if (rawCorsOrigins.length === 0) {
  logger.error("[CORS] CORS_ORIGIN is not set - all cross-origin requests will be rejected. Set CORS_ORIGIN in functions/.env");
}

const corsHandler = cors({
  origin: (origin, callback) => {
    if (!origin) { callback(null, true); return; }
    if (rawCorsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin "${origin}" is not allowed`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

async function verifyUserRole(req: functions.https.Request): Promise<admin.auth.DecodedIdToken> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
  const decoded = await admin.auth().verifyIdToken(header.split("Bearer ")[1]);
  checkUserRole(decoded);
  return decoded;
}

async function verifyAdmin(req: functions.https.Request, functionName?: string): Promise<admin.auth.DecodedIdToken> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
  const decoded = await admin.auth().verifyIdToken(header.split("Bearer ")[1], true);
  checkAdminRole(decoded, decoded.uid, functionName);
  return decoded;
}

// ─── User Profile ─────────────────────────────────────────────────────────────

const USERS_COLLECTION = "users";

type FirestoreUserProfile = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: "user" | "admin";
  subscription: Subscription;
  preferences: { itemsPerPage: number };
  createdAt: admin.firestore.FieldValue;
  updatedAt: admin.firestore.FieldValue;
};

async function buildDefaultSubscription(plan: SubscriptionPlan = "free"): Promise<Subscription> {
  return {
    plan,
    status: "active",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    cancelAtPeriodEnd: false,
  };
}

async function buildUserProfile(fields: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}): Promise<FirestoreUserProfile> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  return {
    uid: fields.uid,
    email: fields.email ?? null,
    displayName: fields.displayName ?? null,
    photoURL: fields.photoURL ?? null,
    role: "user",
    subscription: await buildDefaultSubscription("free"),
    preferences: { itemsPerPage: 20 },
    createdAt: now,
    updatedAt: now,
  };
}

async function createUserProfile(user: admin.auth.UserRecord): Promise<void> {
  logger.info("createUserProfile START", { uid: user.uid, email: user.email ?? "none" });
  const ref = db.collection(USERS_COLLECTION).doc(user.uid);
  const profile = await buildUserProfile({
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  });
  try {
    await ref.create(profile);
    logger.info("createUserProfile SUCCESS", { uid: user.uid });
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 6) { logger.info("createUserProfile ALREADY EXISTS (code=6, skipping)", { uid: user.uid }); return; }
    logger.error("createUserProfile FAILED", { uid: user.uid, code });
    throw err;
  }
}

async function ensureUserProfile(uid: string): Promise<void> {
  const ref = db.collection(USERS_COLLECTION).doc(uid);
  const snap = await ref.get();
  if (snap.exists) return;
  logger.info("ensureUserProfile MISSING - creating profile", { uid });
  let email: string | null = null;
  let displayName: string | null = null;
  let photoURL: string | null = null;
  try {
    const userRecord = await admin.auth().getUser(uid);
    email = userRecord.email ?? null;
    displayName = userRecord.displayName ?? null;
    photoURL = userRecord.photoURL ?? null;
  } catch (err) {
    logger.error("ensureUserProfile failed to fetch auth record", { uid });
  }
  const profile = await buildUserProfile({ uid, email, displayName, photoURL });
  try {
    await ref.create(profile);
    logger.info("ensureUserProfile CREATED", { uid });
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 6) { logger.info("ensureUserProfile ALREADY EXISTS (race)", { uid }); return; }
    logger.error("ensureUserProfile FAILED", { uid, code });
    throw err;
  }
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;

async function checkRateLimit(uid: string, fnName: string, maxRequests: number): Promise<number | null> {
  const key = `${uid}_${fnName}`;
  const ref = db.collection("rateLimits").doc(key);
  const now = Date.now();
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()!.resetAt.toMillis() <= now) {
        tx.set(ref, { count: 1, resetAt: Timestamp.fromMillis(now + RATE_LIMIT_WINDOW_MS) });
        return null;
      }
      const count: number = snap.data()!.count;
      const resetAt: number = snap.data()!.resetAt.toMillis();
      if (count >= maxRequests) return resetAt;
      tx.update(ref, { count: count + 1 });
      return null;
    });
  } catch (err) {
    logger.error("rateLimit Firestore error", { uid, fnName, error: err instanceof Error ? err.message : String(err) });
    return Date.now() + RATE_LIMIT_WINDOW_MS;
  }
}

function replyRateLimited(res: functions.Response, resetAtMs: number): void {
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  res.set("Retry-After", String(retryAfter));
  res.status(429).json({ error: "Too many requests. Please wait a moment.", retryAfter });
}

// ─── Auth Trigger ─────────────────────────────────────────────────────────────

export const onUserCreate = functions.auth.user().onCreate(async (user) => {
  const log = createLogger(undefined, { function_name: "onUserCreate" });
  log.info("TRIGGERED", { uid: user.uid, email: user.email ?? "none" });
  try {
    await admin.auth().setCustomUserClaims(user.uid, { role: "user" });
    log.info("custom claim set", { uid: user.uid });
  } catch (err) {
    log.error("FAILED to set custom claim", { uid: user.uid });
    throw err;
  }
  await createUserProfile(user);
  log.info("COMPLETE", { uid: user.uid });
});

// ─── Callable: Send password reset email ─────────────────────────────────────

export const sendPasswordReset = functions.https.onCall(async (data, _context) => {
  const email = (data?.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid email address is required.");
  }
  const rateLimitRef = db.collection("rateLimits").doc(`pwreset:${email}`);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rateLimitRef);
    const existing = snap.exists ? (snap.data() as { count: number; windowStart: number }) : null;
    if (existing && now - existing.windowStart < windowMs) {
      if (existing.count >= 3) {
        throw new functions.https.HttpsError("resource-exhausted", "Too many reset requests. Please wait before trying again.");
      }
      tx.update(rateLimitRef, { count: existing.count + 1 });
    } else {
      tx.set(rateLimitRef, { count: 1, windowStart: now });
    }
  });
  try {
    const resetLink = await admin.auth().generatePasswordResetLink(email);
    sendPasswordResetEmailViaResend(email, resetLink).catch((sendErr) =>
      logger.error("sendPasswordReset Resend delivery failed", { error: sendErr?.message ?? String(sendErr) })
    );
  } catch (err: any) {
    if (err instanceof functions.https.HttpsError) throw err;
    logger.error("sendPasswordReset Error", { error: err?.message ?? String(err) });
  }
  return { success: true };
});

// ─── Callable: Resend verification email ─────────────────────────────────────

const VERIFY_EMAIL_RATE_LIMIT_MAX = 3;
const VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS = 2 * 60_000;

export const resendVerificationEmail = functions.https.onCall(async (_data, context) => {
  const log = createLogger(undefined, { function_name: "resendVerificationEmail" });
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const rlKey = `${uid}_resendVerificationEmail`;
  const rlRef = db.collection("rateLimits").doc(rlKey);
  const now = Date.now();
  const resetAtMs = await db.runTransaction(async (tx) => {
    const snap = await tx.get(rlRef);
    if (!snap.exists || snap.data()!.resetAt.toMillis() <= now) {
      tx.set(rlRef, { count: 1, resetAt: Timestamp.fromMillis(now + VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS) });
      return null;
    }
    const count: number = snap.data()!.count;
    const resetAt: number = snap.data()!.resetAt.toMillis();
    if (count >= VERIFY_EMAIL_RATE_LIMIT_MAX) return resetAt;
    tx.update(rlRef, { count: count + 1 });
    return null;
  }).catch((err) => { log.error("Rate limit Firestore error", { uid, error: err instanceof Error ? err.message : String(err) }); return null; });

  if (resetAtMs !== null) {
    const waitSecs = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
    throw new functions.https.HttpsError("resource-exhausted", `Too many attempts. Please wait ${waitSecs} seconds.`);
  }
  const userRecord = await admin.auth().getUser(uid);
  if (userRecord.emailVerified) return { success: true };
  if (!userRecord.email) throw new functions.https.HttpsError("failed-precondition", "No email address on account.");
  try {
    const verificationLink = await admin.auth().generateEmailVerificationLink(userRecord.email);
    sendVerificationEmailToAddress(userRecord.email, verificationLink).catch((sendErr) =>
      log.error("Resend delivery failed", { uid, error: sendErr?.message ?? String(sendErr) })
    );
  } catch (err: any) {
    const msg: string = err?.errorInfo?.message ?? err?.message ?? "";
    if (msg.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
      throw new functions.https.HttpsError("resource-exhausted", "Too many attempts. Please wait a few minutes.");
    }
    throw new functions.https.HttpsError("internal", "Failed to send verification email. Please try again.");
  }
  return { success: true };
});

// ─── Callable: Delete user account ───────────────────────────────────────────

export const deleteUserAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  if (data?.confirm !== true) throw new functions.https.HttpsError("invalid-argument", "Confirm must be true.");
  const uid = context.auth.uid;
  const log = createLogger(undefined, { function_name: "deleteUserAccount" });
  log.info("deleteUserAccount START", { uid });

  // Cancel any active Stripe subscription before deleting
  try {
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    if (userSnap.exists) {
      const sub = userSnap.data()?.subscription;
      if (sub?.stripeSubscriptionId) {
        await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
        log.info("Stripe subscription cancelled", { uid });
      }
    }
  } catch (err) {
    log.error("Failed to cancel Stripe subscription during account deletion", { uid, error: err instanceof Error ? err.message : String(err) });
  }

  // Delete Firestore user document and subcollections
  try {
    const userRef = db.collection(USERS_COLLECTION).doc(uid);
    // Delete known subcollections
    for (const sub of ["items", "notifications", "preferences"]) {
      const snap = await userRef.collection(sub).get();
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      if (snap.docs.length > 0) await batch.commit();
    }
    await userRef.delete();
    log.info("Firestore user data deleted", { uid });
  } catch (err) {
    log.error("Failed to delete Firestore user data", { uid, error: err instanceof Error ? err.message : String(err) });
  }

  // Delete Firebase Auth account
  await admin.auth().deleteUser(uid);
  log.info("deleteUserAccount COMPLETE", { uid });
  return { success: true };
});

// ─── Billing: Create Checkout Session ────────────────────────────────────────

export const createCheckoutSession = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const { priceId } = req.body ?? {};
    if (!priceId || typeof priceId !== "string") { res.status(400).json({ error: "priceId is required." }); return; }

    await ensureUserProfile(uid);
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const email = userSnap.data()?.email ?? decoded.email ?? undefined;

    let customerId: string | undefined = userSnap.data()?.subscription?.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await getStripe().customers.create({ email, metadata: { uid } });
      customerId = customer.id;
      await db.collection(USERS_COLLECTION).doc(uid).update({ "subscription.stripeCustomerId": customerId });
    }

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/billing`,
      metadata: { uid },
    });
    res.json({ url: session.url });
  });
});

// ─── Billing: Create Portal Session ──────────────────────────────────────────

export const createPortalSession = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const customerId = userSnap.data()?.subscription?.stripeCustomerId;
    if (!customerId) { res.status(400).json({ error: "No billing account found." }); return; }
    const { priceId } = req.body ?? {};
    const flowData = priceId ? {
      type: "subscription_update_confirm" as const,
      subscription_update_confirm: {
        subscription: userSnap.data()?.subscription?.stripeSubscriptionId,
        items: [{ id: (await getStripe().subscriptions.retrieve(userSnap.data()?.subscription?.stripeSubscriptionId)).items.data[0].id, price: priceId }],
      },
    } : undefined;
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/billing`,
      ...(flowData ? { flow_data: flowData } : {}),
    });
    res.json({ url: session.url });
  });
});

// ─── Billing: Cancel Subscription ────────────────────────────────────────────

export const cancelSubscription = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const subId = userSnap.data()?.subscription?.stripeSubscriptionId;
    if (!subId) { res.status(400).json({ error: "No active subscription." }); return; }
    await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
    await db.collection(USERS_COLLECTION).doc(uid).update({ "subscription.cancelAtPeriodEnd": true });
    res.json({ success: true });
  });
});

// ─── Billing: Reactivate Subscription ────────────────────────────────────────

export const reactivateSubscription = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const subId = userSnap.data()?.subscription?.stripeSubscriptionId;
    if (!subId) { res.status(400).json({ error: "No active subscription." }); return; }
    await getStripe().subscriptions.update(subId, { cancel_at_period_end: false });
    await db.collection(USERS_COLLECTION).doc(uid).update({ "subscription.cancelAtPeriodEnd": false });
    res.json({ success: true });
  });
});

// ─── Billing: Change Subscription ────────────────────────────────────────────

export const changeSubscription = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const customerId = userSnap.data()?.subscription?.stripeCustomerId;
    if (!customerId) { res.status(400).json({ error: "No billing account found." }); return; }
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/billing`,
    });
    res.json({ url: session.url });
  });
});

// ─── Billing: Sync Subscription ──────────────────────────────────────────────

export const syncSubscription = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const subId = userSnap.data()?.subscription?.stripeSubscriptionId;
    if (!subId) { res.json({ synced: false, reason: "no_subscription" }); return; }
    // In emulator/dev mode with a placeholder Stripe key, skip the Stripe call
    const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
    if (!stripeKey || stripeKey.startsWith("sk_test_placeholder")) {
      res.json({ synced: false, reason: "stripe_not_configured" }); return;
    }
    const stripeSub = await getStripe().subscriptions.retrieve(subId) as any;
    const priceIdToPlan = await buildPriceIdToPlanMap();
    const priceId = stripeSub.items.data[0]?.price?.id;
    const plan = (priceId ? priceIdToPlan.get(priceId) : undefined) ?? "free";
    await db.collection(USERS_COLLECTION).doc(uid).update({
      "subscription.plan": plan,
      "subscription.status": stripeSub.status,
      "subscription.cancelAtPeriodEnd": stripeSub.cancel_at_period_end,
      "subscription.currentPeriodStart": stripeSub.current_period_start ? admin.firestore.Timestamp.fromMillis(stripeSub.current_period_start * 1000) : null,
      "subscription.currentPeriodEnd": stripeSub.current_period_end ? admin.firestore.Timestamp.fromMillis(stripeSub.current_period_end * 1000) : null,
      "subscription.stripePriceId": priceId ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ synced: true, plan });
  });
});

// ─── Billing: Get Invoices ────────────────────────────────────────────────────

export const getInvoices = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const customerId = userSnap.data()?.subscription?.stripeCustomerId;
    if (!customerId) { res.json({ invoices: [], hasMore: false }); return; }
    const startingAfter = typeof req.query.startingAfter === "string" ? req.query.startingAfter : undefined;
    const list = await getStripe().invoices.list({ customer: customerId, limit: 12, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const invoices = list.data.map((inv: any) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_due,
      currency: inv.currency,
      created: inv.created,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdf: inv.invoice_pdf ?? null,
      refunded: (inv.amount_refunded ?? 0) > 0,
      amountRefunded: inv.amount_refunded ?? 0,
    }));
    res.json({ invoices, hasMore: list.has_more });
  });
});

// ─── Billing: Stripe Webhook ──────────────────────────────────────────────────

export const stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !webhookSecret) { res.status(400).send("Missing signature or webhook secret"); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    logger.error("Stripe webhook signature verification failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(400).send("Webhook signature verification failed");
    return;
  }

  // Idempotency: skip already-processed events
  const eventRef = db.collection("processedWebhookEvents").doc(event.id);
  const eventSnap = await eventRef.get();
  if (eventSnap.exists) { res.json({ received: true, skipped: true }); return; }
  await eventRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp(), type: event.type });

  const priceIdToPlan = await buildPriceIdToPlanMap();

  async function updateSubscriptionFromStripe(subscription: any): Promise<void> {
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const usersSnap = await db.collection(USERS_COLLECTION).where("subscription.stripeCustomerId", "==", customerId).limit(1).get();
    if (usersSnap.empty) { logger.error("stripeWebhook: no user found for customer", { customerId }); return; }
    const userRef = usersSnap.docs[0].ref;
    const priceId = subscription.items.data[0]?.price?.id;
    const plan = (priceId ? priceIdToPlan.get(priceId) : undefined) ?? "free";
    await userRef.update({
      "subscription.plan": plan,
      "subscription.status": subscription.status,
      "subscription.stripeSubscriptionId": subscription.id,
      "subscription.cancelAtPeriodEnd": subscription.cancel_at_period_end,
      "subscription.currentPeriodStart": subscription.current_period_start ? admin.firestore.Timestamp.fromMillis(subscription.current_period_start * 1000) : null,
      "subscription.currentPeriodEnd": subscription.current_period_end ? admin.firestore.Timestamp.fromMillis(subscription.current_period_end * 1000) : null,
      "subscription.stripePriceId": priceId ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info("stripeWebhook: subscription updated", { plan, status: subscription.status });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as any;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await getStripe().subscriptions.retrieve(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
          await updateSubscriptionFromStripe(sub);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as any;
        await updateSubscriptionFromStripe(sub);
        if (event.type === "customer.subscription.deleted") {
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
          const usersSnap = await db.collection(USERS_COLLECTION).where("subscription.stripeCustomerId", "==", customerId).limit(1).get();
          if (!usersSnap.empty) {
            await usersSnap.docs[0].ref.update({
              "subscription.plan": "free",
              "subscription.status": "cancelled",
              "subscription.stripeSubscriptionId": null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as any;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        const usersSnap = await db.collection(USERS_COLLECTION).where("subscription.stripeCustomerId", "==", customerId).limit(1).get();
        if (!usersSnap.empty) {
          await usersSnap.docs[0].ref.update({ "subscription.status": "past_due", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        break;
      }
      default:
        logger.info("stripeWebhook: unhandled event type", { type: event.type });
    }
  } catch (err) {
    logger.error("stripeWebhook: handler error", { type: event.type, error: err instanceof Error ? err.message : String(err) });
    res.status(500).send("Handler error");
    return;
  }

  res.json({ received: true });
});

// ─── Admin: Seed Plans ────────────────────────────────────────────────────────

export const seedPlans = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAdmin(req, "seedPlans"); } catch { res.status(403).json({ error: "Forbidden." }); return; }
    const plans = buildPlanSeedData();
    for (const plan of plans) {
      const id = PLAN_IDS.find((pid) => plan.name.toLowerCase().startsWith(pid.toLowerCase())) ?? plan.name.toLowerCase();
      await db.collection("plans").doc(id).set(plan, { merge: true });
    }
    invalidatePlanCache();
    res.json({ success: true, count: plans.length });
  });
});

// ─── Admin: Get Stats ─────────────────────────────────────────────────────────

export const getAdminStats = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAdmin(req, "getAdminStats"); } catch { res.status(403).json({ error: "Forbidden." }); return; }
    const statsSnap = await db.collection("admin").doc("stats").get();
    const stats = statsSnap.exists ? statsSnap.data() : {};
    const usersSnap = await db.collection(USERS_COLLECTION).count().get();
    res.json({ ...stats, totalUsers: usersSnap.data().count });
  });
});

// ─── Admin: Trigger Backup ────────────────────────────────────────────────────

export const triggerBackup = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAdmin(req, "triggerBackup"); } catch { res.status(403).json({ error: "Forbidden." }); return; }
    const bucket = process.env.BACKUP_BUCKET;
    if (!bucket) { res.status(500).json({ error: "BACKUP_BUCKET is not configured." }); return; }
    const client = new admin.firestore.v1.FirestoreAdminClient();
    const projectId = process.env.GCLOUD_PROJECT ?? admin.instanceId().app.options.projectId ?? "";
    const databaseName = client.databasePath(projectId, "(default)");
    const [operation] = await client.exportDocuments({ name: databaseName, outputUriPrefix: bucket, collectionIds: [] });
    res.json({ success: true, operationName: operation.name });
  });
});

// ─── Support: Submit Ticket ───────────────────────────────────────────────────

export const submitSupportTicket = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    const { category, subject, message, replyEmail } = req.body ?? {};
    const cleanCategory = sanitizeString(category, 50) ?? "other";
    const cleanSubject = sanitizeString(subject, 200);
    const cleanMessage = sanitizeString(message, 5000);
    if (!cleanSubject || !cleanMessage) { res.status(400).json({ error: "subject and message are required." }); return; }
    const userSnap = await db.collection(USERS_COLLECTION).doc(uid).get();
    const userEmail = userSnap.data()?.email ?? decoded.email ?? "";
    const resolvedReplyEmail = typeof replyEmail === "string" && replyEmail.includes("@") ? replyEmail : userEmail;
    const ticketId = crypto.randomUUID();
    const { sendSupportTicketEmail } = await import("./emailService");
    await sendSupportTicketEmail({ ticketId, uid, userEmail, replyEmail: resolvedReplyEmail, category: cleanCategory, subject: cleanSubject, message: cleanMessage });
    res.json({ ticketId });
  });
});

// ─── Error Reporting ──────────────────────────────────────────────────────────

export const reportFrontendError = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    const { message, stack, url, userAgent, timestamp, uid } = req.body ?? {};
    if (!message || typeof message !== "string") { res.status(400).json({ error: "message is required." }); return; }
    logger.error("Frontend error reported", {
      message: String(message).slice(0, 500),
      stack: stack ? String(stack).slice(0, 2000) : null,
      url: url ? String(url).slice(0, 500) : null,
      userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
      timestamp: timestamp ? String(timestamp) : null,
      uid: uid ? String(uid).slice(0, 8) : null,
    });
    res.json({ received: true });
  });
});

// ─── Items API (canonical example feature) ───────────────────────────────────
// This is the reference implementation showing how to add a new feature.
// See ARCHITECTURE.md for the full pattern description.

const MAX_TITLE_LEN = 200;
const MAX_DESC_LEN = 2000;

export const itemsApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await verifyUserRole(req); } catch { res.status(401).json({ error: "Unauthorized." }); return; }
    const uid = decoded.uid;
    await ensureUserProfile(uid);
    const itemsRef = db.collection(USERS_COLLECTION).doc(uid).collection("items");

    // GET /api/items - list all items
    if (req.method === "GET") {
      const snap = await itemsRef.orderBy("createdAt", "desc").get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json({ items });
      return;
    }

    // POST /api/items - create item
    if (req.method === "POST") {
      const rateLimitReset = await checkRateLimit(uid, "createItem", 30);
      if (rateLimitReset !== null) { replyRateLimited(res, rateLimitReset); return; }
      const title = sanitizeString(req.body?.title, MAX_TITLE_LEN);
      const description = sanitizeString(req.body?.description ?? "", MAX_DESC_LEN) ?? "";
      if (!title) { res.status(400).json({ error: "title is required (letters, numbers, basic punctuation only)." }); return; }
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = await itemsRef.add({ title, description, status: "active", createdAt: now, updatedAt: now });
      res.status(201).json({ id: ref.id, title, description, status: "active" });
      return;
    }

    // PATCH /api/items/:id - update item
    if (req.method === "PATCH") {
      const id = req.path.split("/").filter(Boolean).pop();
      if (!id) { res.status(400).json({ error: "Item ID is required." }); return; }
      const ref = itemsRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ error: "Item not found." }); return; }
      const updates: Record<string, unknown> = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (req.body?.title !== undefined) {
        const title = sanitizeString(req.body.title, MAX_TITLE_LEN);
        if (!title) { res.status(400).json({ error: "Invalid title." }); return; }
        updates.title = title;
      }
      if (req.body?.description !== undefined) updates.description = sanitizeString(req.body.description, MAX_DESC_LEN) ?? "";
      if (req.body?.status !== undefined) {
        if (!["active", "archived"].includes(req.body.status)) { res.status(400).json({ error: "status must be active or archived." }); return; }
        updates.status = req.body.status;
      }
      await ref.update(updates);
      res.json({ id, ...snap.data(), ...updates });
      return;
    }

    // DELETE /api/items/:id - delete item
    if (req.method === "DELETE") {
      const id = req.path.split("/").filter(Boolean).pop();
      if (!id) { res.status(400).json({ error: "Item ID is required." }); return; }
      const ref = itemsRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ error: "Item not found." }); return; }
      await ref.delete();
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  });
});

// ─── FieldStack Domain Functions ──────────────────────────────────────────────

export { projectsApi } from "./fieldstack/projects";
export { schedulesUploadApi } from "./fieldstack/schedules";
export { ordersApi } from "./fieldstack/orders";
export { alertsSendApi, alertsSendToMemberApi, alertsEvaluateCron } from "./fieldstack/alerts";
export { chatApi, briefingApi } from "./fieldstack/chat";
export { teamApi } from "./fieldstack/team";
export {
  leadTimesApi,
  gmailApi,
  gmailCallbackApi,
  gmailScanApi,
  smsBriefingApi,
  myTasksApi,
  procoreAuthUrlApi,
} from "./fieldstack/settings";
export { stepsApi } from "./fieldstack/steps";
export { magicLinkApi } from "./fieldstack/magicLink";
export { escalationApi, escalationCron, digestCron } from "./fieldstack/escalation";
export { gcDraftApi } from "./fieldstack/gcDraft";
export { fromScheduleApi } from "./fieldstack/fromSchedule";
export { procoreCallbackApi, procoreWebhookApi, procoreSyncApi, procoreSyncCron } from "./fieldstack/procore";
export { pendingChangesApi } from "./fieldstack/pendingChanges";
export { inviteSubApi, inviteAcceptApi } from "./fieldstack/inviteSub";
