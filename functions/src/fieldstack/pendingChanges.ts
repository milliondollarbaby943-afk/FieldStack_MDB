/**
 * Pending Changes Cloud Function — sub date change requests + GC approval flow.
 *
 * GET  /api/pending-changes?projectId=X   — GC: list pending changes for a project
 * POST /api/pending-changes               — Sub: request a new install date for a task
 * PATCH /api/pending-changes/{id}/approve — GC: approve request → update task + create scheduleChange
 * PATCH /api/pending-changes/{id}/reject  — GC: reject request with reason
 *
 * Conflict logic: if two subs request a date change for the same taskId, both are
 * flagged as CONFLICT and require GC resolution (approve one / reject the other).
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import { Resend } from "resend";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest, replyNotFound } from "./middleware";
import { COLLECTIONS } from "./types";
import { sanitizeString } from "../validation";
import { logger } from "../logger";

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

const FROM = process.env.EMAIL_FROM ?? "alerts@fieldstack.app";

const db = admin.firestore();

const rawCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

const corsHandler = cors({
  origin: (origin, callback) => {
    if (!origin || rawCorsOrigins.includes(origin)) { callback(null, true); return; }
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

export const pendingChangesApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    let companyId: string;
    let uid: string;
    let userRole: string;
    let requestedByEmail: string | null = null;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
      uid = auth.decoded.uid;
      userRole = auth.role;
      requestedByEmail = auth.decoded.email ?? null;
    } catch {
      replyUnauthorized(res); return;
    }

    // ── PATCH /{id}/approve or /{id}/reject ───────────────────────────────────
    const patchMatch = req.path.match(/\/([^/]+)\/(approve|reject)$/);
    if (req.method === "PATCH" && patchMatch) {
      const [, changeId, action] = patchMatch;

      // Only GC-level roles (ADMIN, MEMBER with owner/supervisor) can approve/reject.
      // For simplicity, any authenticated company member can approve/reject (GC controls access).
      const changeSnap = await db
        .collectionGroup("pendingChanges")
        .where("id", "==", changeId)
        .where("companyId", "==", companyId)
        .limit(1)
        .get();

      if (changeSnap.empty) { replyNotFound(res, "Pending change not found."); return; }

      const changeRef = changeSnap.docs[0].ref;
      const change = changeSnap.docs[0].data();

      if (change.status === "APPROVED" || change.status === "REJECTED") {
        replyBadRequest(res, "This change request has already been resolved."); return;
      }

      if (action === "approve") {
        const batch = db.batch();

        // Update the pending change status
        batch.update(changeRef, {
          status: "APPROVED",
          reviewedBy: uid,
          reviewedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Update the task's gcInstallDate
        const taskRef = db.doc(
          `${COLLECTIONS.tasks(companyId, change.projectId)}/${change.taskId}`
        );
        batch.update(taskRef, {
          gcInstallDate: Timestamp.fromMillis(change.requestedDate.toMillis()),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Create a scheduleChange entry
        const scCol = COLLECTIONS.scheduleChanges(companyId, change.projectId);
        const scRef = db.collection(scCol).doc();
        const shiftDays = Math.round(
          (change.requestedDate.toMillis() - change.originalDate.toMillis()) / (1000 * 60 * 60 * 24)
        );
        batch.set(scRef, {
          id: scRef.id,
          projectId: change.projectId,
          companyId,
          taskId: change.taskId,
          detectedAt: FieldValue.serverTimestamp(),
          previousDate: change.originalDate,
          newDate: change.requestedDate,
          shiftDays,
          notificationsSent: false,
          taskName: change.taskName ?? null,
          building: change.building ?? null,
          floor: change.floor ?? null,
          sourceType: "SUB_REQUEST",
          approvedBy: uid,
        });

        // If there are other CONFLICT/PENDING changes for the same task, auto-reject them
        const otherChangesSnap = await db
          .collectionGroup("pendingChanges")
          .where("taskId", "==", change.taskId)
          .where("companyId", "==", companyId)
          .where("status", "in", ["PENDING", "CONFLICT"])
          .get();

        for (const doc of otherChangesSnap.docs) {
          if (doc.id !== changeId) {
            batch.update(doc.ref, {
              status: "REJECTED",
              rejectionReason: "Another date change request was approved for this task.",
              reviewedBy: uid,
              reviewedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        }

        await batch.commit();
        logger.info("pendingChange approved", { companyId, changeId, taskId: change.taskId });

        // Send approval email to sub — must not fail the API response
        try {
          const resend = getResend();
          const subEmail = change.requestedByEmail as string | null | undefined;
          if (resend && subEmail) {
            const newDateStr = new Date(change.requestedDate.toMillis()).toLocaleDateString("en-US", {
              year: "numeric", month: "long", day: "numeric",
            });
            const origDateStr = new Date(change.originalDate.toMillis()).toLocaleDateString("en-US", {
              year: "numeric", month: "long", day: "numeric",
            });
            const taskLabel = change.taskName ? `<strong>${change.taskName}</strong>` : "your task";
            await resend.emails.send({
              from: FROM,
              to: subEmail,
              subject: "Your date change request was approved",
              html: `<p>Hi,</p>
<p>Your date change request for ${taskLabel} has been <strong>approved</strong>.</p>
<ul>
  <li><strong>Original date:</strong> ${origDateStr}</li>
  <li><strong>New date:</strong> ${newDateStr}</li>
</ul>
${change.notes ? `<p><strong>Your notes:</strong> ${change.notes}</p>` : ""}
<p>Thank you,<br>FieldStack</p>`,
            });
          }
        } catch (emailErr) {
          logger.warn("pendingChange approve: failed to send approval email", { changeId, error: emailErr });
        }

        res.json({ success: true }); return;
      }

      if (action === "reject") {
        const { reason } = req.body ?? {};
        await changeRef.update({
          status: "REJECTED",
          rejectionReason: reason ? sanitizeString(reason) : null,
          reviewedBy: uid,
          reviewedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        logger.info("pendingChange rejected", { companyId, changeId });

        // Send rejection email to sub — must not fail the API response
        try {
          const resend = getResend();
          const subEmail = change.requestedByEmail as string | null | undefined;
          if (resend && subEmail) {
            const requestedDateStr = new Date(change.requestedDate.toMillis()).toLocaleDateString("en-US", {
              year: "numeric", month: "long", day: "numeric",
            });
            const taskLabel = change.taskName ? `<strong>${change.taskName}</strong>` : "your task";
            const sanitizedReason = reason ? sanitizeString(reason) : null;
            await resend.emails.send({
              from: FROM,
              to: subEmail,
              subject: "Your date change request was not approved",
              html: `<p>Hi,</p>
<p>Your date change request for ${taskLabel} (requested date: ${requestedDateStr}) has been <strong>rejected</strong>.</p>
${sanitizedReason ? `<p><strong>Reason:</strong> ${sanitizedReason}</p>` : ""}
<p>Please reach out to your GC if you have questions.</p>
<p>Thank you,<br>FieldStack</p>`,
            });
          }
        } catch (emailErr) {
          logger.warn("pendingChange reject: failed to send rejection email", { changeId, error: emailErr });
        }

        res.json({ success: true }); return;
      }
    }

    // ── GET ?projectId=X[&gcCompanyId=Y] ─────────────────────────────────────
    if (req.method === "GET") {
      const projectId = req.query.projectId as string | undefined;
      const gcCompanyId = req.query.gcCompanyId as string | undefined;
      if (!projectId) { replyBadRequest(res, "projectId query parameter required."); return; }

      const ownerCompanyId = (gcCompanyId && gcCompanyId !== companyId) ? gcCompanyId : companyId;

      // Sub viewing their own requests: validate active project connection first
      if (gcCompanyId && gcCompanyId !== companyId) {
        const connSnap = await db
          .doc(`${COLLECTIONS.projectConnections(gcCompanyId)}/${projectId}_${companyId}`)
          .get();
        if (!connSnap.exists || connSnap.data()?.status !== "ACTIVE") {
          replyUnauthorized(res); return;
        }
      }

      const col = `${COLLECTIONS.projects(ownerCompanyId)}/${projectId}/pendingChanges`;
      const snap = await db.collection(col).orderBy("createdAt", "desc").get();
      let changes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Sub users: return only their own requests
      if (gcCompanyId && gcCompanyId !== companyId) {
        changes = changes.filter((c) => (c as Record<string, unknown>).subCompanyId === companyId);
      }

      res.json(changes); return;
    }

    // ── POST — Sub requests a date change ─────────────────────────────────────
    if (req.method === "POST") {
      const { projectId, taskId, requestedDate, notes, requestedByName, gcCompanyId } = req.body ?? {};
      if (!projectId || !taskId || !requestedDate) {
        replyBadRequest(res, "projectId, taskId, and requestedDate are required."); return;
      }
      if (!gcCompanyId) {
        replyBadRequest(res, "gcCompanyId is required."); return;
      }

      // Tasks live under the GC's Firestore path, not the sub's
      const taskRef = db.doc(`${COLLECTIONS.tasks(gcCompanyId, projectId)}/${taskId}`);
      const taskSnap = await taskRef.get();
      if (!taskSnap.exists || taskSnap.data()?.companyId !== gcCompanyId) {
        replyNotFound(res, "Task not found."); return;
      }
      const task = taskSnap.data()!;

      // Verify the requesting sub is actually assigned to this task
      if (task.assignedSubCompanyId !== companyId) {
        replyNotFound(res, "Task not found."); return;
      }

      const parsedDate = new Date(requestedDate);
      if (isNaN(parsedDate.getTime())) {
        replyBadRequest(res, "requestedDate must be a valid date string."); return;
      }
      const originalDate = task.gcInstallDate as Timestamp;
      const newDate = Timestamp.fromDate(parsedDate);

      // pendingChanges stored under GC's project path so GC approve/reject can find them
      const col = `${COLLECTIONS.projects(gcCompanyId)}/${projectId}/pendingChanges`;

      // Check for existing PENDING or CONFLICT changes on the same task
      const existingSnap = await db
        .collection(col)
        .where("taskId", "==", taskId)
        .where("status", "in", ["PENDING", "CONFLICT"])
        .get();

      // Detect if this user already has a pending request for this task
      const myExisting = existingSnap.docs.find((d) => d.data().requestedBy === uid);
      if (myExisting) {
        // Update the existing request rather than creating a duplicate
        await myExisting.ref.update({
          requestedDate: newDate,
          notes: notes ? sanitizeString(notes) : null,
          requestedByEmail,
          updatedAt: FieldValue.serverTimestamp(),
        });
        res.json({ id: myExisting.id }); return;
      }

      // Determine status — conflict if another sub already has a pending request
      const otherPending = existingSnap.docs.filter((d) => d.data().requestedBy !== uid);
      const isConflict = otherPending.length > 0;

      const batch = db.batch();

      const ref = db.collection(col).doc();
      batch.set(ref, {
        id: ref.id,
        projectId,
        companyId: gcCompanyId,    // GC's companyId so GC's approve/reject queries match
        subCompanyId: companyId,   // which sub submitted this request
        taskId,
        requestedBy: uid,
        requestedByName: requestedByName ? sanitizeString(requestedByName) : null,
        requestedByEmail,          // denormalized for approve/reject notification emails
        requestedDate: newDate,
        originalDate,
        notes: notes ? sanitizeString(notes) : null,
        status: isConflict ? "CONFLICT" : "PENDING",
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
        // Denormalized from task
        taskName: task.taskName ?? null,
        building: task.building ?? null,
        floor: task.floor ?? null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Escalate existing PENDING requests to CONFLICT
      if (isConflict) {
        for (const doc of otherPending) {
          if (doc.data().status === "PENDING") {
            batch.update(doc.ref, {
              status: "CONFLICT",
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        }
      }

      await batch.commit();
      logger.info("pendingChange created", { subCompanyId: companyId, gcCompanyId, projectId, taskId, isConflict });
      res.json({ id: ref.id }); return;
    }

    res.status(405).json({ error: "Method not allowed" });
  });
});
