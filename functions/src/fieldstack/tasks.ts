/**
 * Tasks Cloud Function — PATCH individual task fields (status, dates, resource)
 * and POST bulk-edit via natural language AI instruction.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest, replyNotFound } from "./middleware";
import { sanitizeString } from "../validation";
import { logger } from "../logger";
import { COLLECTIONS } from "./types";
import { createMessage } from "./anthropic";

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

const corsHandlerBulk = cors({
  origin: (origin, callback) => {
    if (!origin || rawCorsOrigins.includes(origin)) { callback(null, true); return; }
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const VALID_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED"];

// ─── PATCH /api/tasks/:projectId/:taskId ────────────────────────────────────

export const tasksApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "PATCH") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    // Path: /api/tasks/{projectId}/{taskId}
    const pathMatch = req.path.match(/\/([^/]+)\/([^/]+)$/);
    const projectId = pathMatch?.[1];
    const taskId = pathMatch?.[2];
    if (!projectId || !taskId) { replyBadRequest(res, "projectId and taskId required."); return; }

    const taskRef = db
      .collection(COLLECTIONS.tasks(companyId, projectId))
      .doc(taskId);
    const taskSnap = await taskRef.get();

    if (!taskSnap.exists) { replyNotFound(res, "Task not found."); return; }

    const { status, gcInstallDate, gcInstallDateEnd, assignedResource } = req.body ?? {};

    const updates: admin.firestore.UpdateData<admin.firestore.DocumentData> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (status !== undefined) {
      if (!VALID_TASK_STATUSES.includes(status)) {
        replyBadRequest(res, "Invalid status. Must be OPEN, IN_PROGRESS, or CLOSED."); return;
      }
      updates.status = status;
    }
    if (gcInstallDate !== undefined) {
      updates.gcInstallDate = gcInstallDate ? Timestamp.fromDate(new Date(gcInstallDate)) : null;
    }
    if (gcInstallDateEnd !== undefined) {
      updates.gcInstallDateEnd = gcInstallDateEnd ? Timestamp.fromDate(new Date(gcInstallDateEnd)) : null;
    }
    if (assignedResource !== undefined) {
      updates.assignedResource = assignedResource ? sanitizeString(assignedResource) : null;
    }

    await taskRef.update(updates);

    logger.info("task updated", { companyId, projectId, taskId, fields: Object.keys(updates) });
    res.json({ success: true });
  });
});

// ─── POST /api/tasks-bulk-edit — AI natural language bulk edit ───────────────

export const tasksBulkEditApi = functions
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest((req, res) => {
  corsHandlerBulk(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const { projectId, instruction, apply } = req.body ?? {};
    if (!projectId || !instruction) {
      replyBadRequest(res, "projectId and instruction are required."); return;
    }

    // Load all tasks for the project
    const tasksSnap = await db
      .collection(COLLECTIONS.tasks(companyId, projectId))
      .get();

    if (tasksSnap.empty) {
      res.json({ changes: [], applied: false }); return;
    }

    const tasks = tasksSnap.docs.map((d) => {
      const data = d.data();
      return {
        taskId: d.id,
        taskName: data.taskName as string,
        building: data.building as string | null,
        floor: data.floor as string | null,
        assignedResource: data.assignedResource as string | null,
        status: (data.status as string) ?? "OPEN",
        gcInstallDate: data.gcInstallDate?.toDate?.()?.toISOString?.() ?? null,
        gcInstallDateEnd: data.gcInstallDateEnd?.toDate?.()?.toISOString?.() ?? null,
      };
    });

    const systemPrompt = `You are a construction schedule assistant. You will be given a list of tasks and a natural-language instruction. Return ONLY a JSON array of changes to apply. Each change object must have:
- taskId: string (from the input)
- field: "status" | "assignedResource" | "gcInstallDate" | "gcInstallDateEnd"
- oldValue: the current value (as a string)
- newValue: the new value to set (as a string; for status must be OPEN, IN_PROGRESS, or CLOSED; for dates use ISO 8601)

Return [] if no changes are needed. Return ONLY valid JSON, no explanation.`;

    const userPrompt = `Instruction: "${sanitizeString(instruction)}"

Current tasks:
${JSON.stringify(tasks, null, 2)}`;

    let changes: Array<{ taskId: string; field: string; oldValue: string; newValue: string; taskName?: string }> = [];

    try {
      const message = await createMessage({
        companyId,
        action: "tasks/bulk-edit",
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as typeof changes;
        changes = parsed.map((c) => ({
          ...c,
          taskName: tasks.find((t) => t.taskId === c.taskId)?.taskName ?? c.taskId,
        }));
      }
    } catch (err) {
      logger.error("bulk edit AI error", { error: err });
      res.status(500).json({ error: "AI parsing failed." }); return;
    }

    if (!apply) {
      res.json({ changes, applied: false });
      return;
    }

    // Apply changes in a batch
    const batch = db.batch();
    const now = FieldValue.serverTimestamp();
    const applied: string[] = [];

    for (const c of changes) {
      const taskRef = db
        .collection(COLLECTIONS.tasks(companyId, projectId))
        .doc(c.taskId);
      const update: admin.firestore.UpdateData<admin.firestore.DocumentData> = { updatedAt: now };

      if (c.field === "status" && VALID_TASK_STATUSES.includes(c.newValue)) {
        update.status = c.newValue;
      } else if (c.field === "assignedResource") {
        update.assignedResource = c.newValue || null;
      } else if (c.field === "gcInstallDate") {
        update.gcInstallDate = Timestamp.fromDate(new Date(c.newValue));
      } else if (c.field === "gcInstallDateEnd") {
        update.gcInstallDateEnd = Timestamp.fromDate(new Date(c.newValue));
      } else {
        continue;
      }

      batch.update(taskRef, update);
      applied.push(c.taskId);
    }

    await batch.commit();

    logger.info("bulk edit applied", { companyId, projectId, count: applied.length });
    res.json({ changes, applied: true, updatedCount: applied.length });
  });
});
