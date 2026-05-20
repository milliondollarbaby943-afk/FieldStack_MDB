/**
 * Tasks CSV Update Cloud Function — POST a CSV file with task edits.
 * Matches rows by taskId (exact) or taskName+building+floor (fuzzy), applies diffs.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import Busboy from "busboy";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest } from "./middleware";
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
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const VALID_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED"];

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

export const tasksCsvUpdateApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    // Parse multipart
    const csvBuffer = await new Promise<{ projectId: string; csvText: string } | null>((resolve) => {
      const bb = Busboy({ headers: req.headers });
      let projectId = "";
      let csvText = "";
      const chunks: Buffer[] = [];

      bb.on("field", (name, val) => {
        if (name === "projectId") projectId = val;
      });
      bb.on("file", (_field, stream) => {
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.on("end", () => { csvText = Buffer.concat(chunks).toString("utf8"); });
      });
      bb.on("finish", () => resolve(projectId && csvText ? { projectId, csvText } : null));
      bb.on("error", () => resolve(null));
      req.pipe(bb);
    });

    if (!csvBuffer) { replyBadRequest(res, "projectId and CSV file required."); return; }

    const { projectId, csvText } = csvBuffer;
    const rows = parseCsv(csvText);
    if (rows.length === 0) { replyBadRequest(res, "CSV has no data rows."); return; }

    // Load all existing tasks
    const tasksSnap = await db
      .collection(COLLECTIONS.tasks(companyId, projectId))
      .get();

    const existingTasks = tasksSnap.docs.map((d) => ({ ref: d.ref, data: d.data() }));

    const batch = db.batch();
    let updated = 0;
    const unmatched: string[] = [];
    const now = FieldValue.serverTimestamp();

    for (const row of rows) {
      const { taskId, taskName, building, floor, status, assignedResource, gcInstallDate, gcInstallDateEnd } = row;

      // Match by taskId first, then fuzzy by name+building+floor
      let match = existingTasks.find((t) => t.data.id === taskId);
      if (!match && taskName) {
        match = existingTasks.find((t) =>
          t.data.taskName === taskName &&
          (t.data.building ?? "") === (building ?? "") &&
          (t.data.floor ?? "") === (floor ?? "")
        );
      }

      if (!match) {
        unmatched.push(taskName ?? taskId ?? "(unknown)");
        continue;
      }

      const update: admin.firestore.UpdateData<admin.firestore.DocumentData> = { updatedAt: now };
      let changed = false;

      if (status && VALID_TASK_STATUSES.includes(status) && status !== match.data.status) {
        update.status = status;
        changed = true;
      }
      if (assignedResource !== undefined && assignedResource !== (match.data.assignedResource ?? "")) {
        update.assignedResource = assignedResource || null;
        changed = true;
      }
      if (gcInstallDate) {
        const d = new Date(gcInstallDate);
        if (!isNaN(d.getTime())) {
          update.gcInstallDate = Timestamp.fromDate(d);
          changed = true;
        }
      }
      if (gcInstallDateEnd !== undefined) {
        if (gcInstallDateEnd === "") {
          update.gcInstallDateEnd = null;
          changed = true;
        } else {
          const d = new Date(gcInstallDateEnd);
          if (!isNaN(d.getTime())) {
            update.gcInstallDateEnd = Timestamp.fromDate(d);
            changed = true;
          }
        }
      }

      if (changed) {
        batch.update(match.ref, update);
        updated++;
      }
    }

    await batch.commit();

    logger.info("csv task update", { companyId, projectId, updated, unmatched: unmatched.length });
    res.json({ updated, unmatched });
  });
});
