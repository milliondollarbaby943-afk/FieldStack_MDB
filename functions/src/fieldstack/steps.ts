/**
 * Task Steps Cloud Function — PATCH step status, notes, assignee, dueDate.
 * Includes cascade logic: when a step completes, downstream dependent steps are unblocked.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest, replyNotFound } from "./middleware";
import { sanitizeString } from "../validation";
import { logger } from "../logger";
import { COLLECTIONS } from "./types";

const db = admin.firestore();

const rawCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

const corsHandler = cors({
  origin: (origin, callback) => {
    if (!origin || rawCorsOrigins.includes(origin)) { callback(null, true); return; }
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  methods: ["PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const VALID_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETE", "BLOCKED"];

export const stepsApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "PATCH") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    // Extract step ID from path: /api/steps/{id}
    const pathMatch = req.path.match(/\/([^/]+)$/);
    const stepId = pathMatch?.[1];
    if (!stepId) { replyBadRequest(res, "Step ID required."); return; }

    // Find the step: GC path first, then sub fallback
    let stepSnap = await db
      .collectionGroup("taskSteps")
      .where("id", "==", stepId)
      .where("companyId", "==", companyId)
      .limit(1)
      .get();

    let isSubStep = false;

    // Sub fallback: step.companyId is the GC's ID; sub found via assignedSubCompanyId
    if (stepSnap.empty) {
      const subSnap = await db
        .collectionGroup("taskSteps")
        .where("id", "==", stepId)
        .where("assignedSubCompanyId", "==", companyId)
        .limit(1)
        .get();

      if (!subSnap.empty) {
        const sd = subSnap.docs[0].data();
        if (sd.projectId && sd.companyId) {
          const connSnap = await db
            .doc(`${COLLECTIONS.projectConnections(sd.companyId as string)}/${sd.projectId}_${companyId}`)
            .get();
          if (connSnap.exists && connSnap.data()?.status === "ACTIVE") {
            stepSnap = subSnap;
            isSubStep = true;
          }
        }
      }
    }

    if (stepSnap.empty) { replyNotFound(res, "Step not found."); return; }

    const stepRef = stepSnap.docs[0].ref;
    const stepData = stepSnap.docs[0].data();

    const { status, notes, assignedToId, dueDate } = req.body ?? {};

    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        replyBadRequest(res, `Invalid status.`); return;
      }
      updates.status = status;
      if (status === "COMPLETE") {
        updates.completedAt = FieldValue.serverTimestamp();
      }
    }
    if (notes !== undefined) updates.notes = sanitizeString(notes) || null;
    // GC-only fields: subs cannot reassign or change due dates
    if (!isSubStep) {
      if (assignedToId !== undefined) updates.assignedToId = assignedToId || null;
      if (dueDate !== undefined) updates.dueDate = dueDate ? Timestamp.fromDate(new Date(dueDate)) : null;
    }

    await stepRef.update(updates);

    // Cascade uses the GC's companyId (step owner), not the requesting user's companyId
    const ownerCompanyId = (stepData.companyId as string | undefined) ?? companyId;
    if (status === "COMPLETE") {
      await onStepComplete(stepId, stepData, ownerCompanyId);
    }

    logger.info("step updated", { companyId, stepId, status, isSubStep });
    res.json({ success: true });
  });
});

/**
 * When a step is marked complete, find steps that depend on it and unblock them.
 * If SHOP_DRAWINGS completes, set SUBMISSIONS due date to +5 business days.
 */
async function onStepComplete(
  stepId: string,
  stepData: admin.firestore.DocumentData,
  companyId: string
): Promise<void> {
  const projectId = stepData.projectId;
  if (!projectId) return;

  // Find steps that depend on this one
  const dependentsSnap = await db
    .collectionGroup("taskSteps")
    .where("dependsOnId", "==", stepId)
    .where("companyId", "==", companyId)
    .get();

  if (dependentsSnap.empty) return;

  const batch = db.batch();
  const now = new Date();

  for (const depDoc of dependentsSnap.docs) {
    const dep = depDoc.data();

    // If SHOP_DRAWINGS completed, set SUBMISSIONS due date (+5 business days)
    if (stepData.stepType === "SHOP_DRAWINGS" && dep.stepType === "SUBMISSIONS") {
      const dueDate = addBusinessDays(now, 5);
      batch.update(depDoc.ref, {
        dueDate: Timestamp.fromDate(dueDate),
        status: "IN_PROGRESS",
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (dep.status === "PENDING") {
      // For other dependencies, unblock by moving to IN_PROGRESS
      batch.update(depDoc.ref, {
        status: "IN_PROGRESS",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  await batch.commit();
  logger.info("onStepComplete cascade", { stepId, dependentsUpdated: dependentsSnap.size });
}

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++; // skip weekends
  }
  return result;
}
