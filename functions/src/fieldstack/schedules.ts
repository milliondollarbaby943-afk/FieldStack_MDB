/**
 * Schedule upload Cloud Function — full implementation.
 *
 * Pipeline:
 * 1. Accept multipart file upload (PDF, XLSX, CSV, TXT)
 * 2. For PDFs: use Claude vision API page-by-page
 *    For XLSX/CSV/TXT: convert to text, use Claude text API
 * 3. Extract tasks with building, floor, dates, category
 * 4. Compute order-by dates using lead time settings
 * 5. Compare with previous version to detect schedule changes
 * 6. Generate 6-step task chains for new buildings/floors
 * 7. Write tasks, orderItems, scheduleChanges, taskSteps to Firestore
 * 8. Update project.alertCounts denormalized field
 * 9. Send change notification emails if version > 1
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import Busboy from "busboy";
import { Resend } from "resend";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest } from "./middleware";
import { COLLECTIONS, DEFAULT_LEAD_TIMES, type ItemType, type TaskCategory } from "./types";
import { createMessage } from "./anthropic";
import { buildScheduleChangeEmailHtml, type ScheduleChangeItem } from "./emailTemplates";
import { logger } from "../logger";

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

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

const FROM = process.env.EMAIL_FROM ?? "alerts@fieldstack.app";

// ─── Claude system prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a construction schedule parser for a cabinet and countertop subcontractor.

Extract ALL tasks from this construction schedule page. Include every trade — nothing should be skipped.

For each task, set "isOurTask" to true ONLY if the task is related to cabinets, countertops, or backsplash (assigned to CKF, BAM, or explicitly mentions cabinets/countertops). All other tasks should have "isOurTask" false.

CRITICAL: You MUST extract the start and end dates for every task. Look at the column headers to identify which columns contain dates. Dates may appear as "Apr 1", "04/01/26", "Mar 23, 2026", or as date ranges in Gantt-style bars. Normalize all dates to YYYY-MM-DD format. If the year is not shown, infer it from context (header, title, or assume current/next year). Tasks without any identifiable date should still be included with startDate set to the best estimate.

Return ONLY a valid JSON array. No prose, no markdown fences, no explanation.

Each object: {"taskIdOriginal":"ID or null","taskName":"exact name","building":"Building X or null","floor":"Floor Y or null","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD or null","assignedResource":"company or null","isOurTask":false}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.replace(/\b([a-zA-Z])([a-zA-Z]*)/g, (_, first, rest) =>
    first.toUpperCase() + rest.toLowerCase()
  );
}

function categorizeTask(taskName: string, resource: string | null): TaskCategory {
  const name = taskName.toLowerCase();
  const res = (resource || "").toLowerCase();
  if (name.includes("cabinet") && name.includes("deliver")) return "CABINET_DELIVERY";
  if (name.includes("cabinet") && name.includes("install")) return "CABINET_INSTALL";
  if (name.includes("countertop") || name.includes("backsplash") || name.includes("set counter")) return "COUNTERTOP_SET";
  if (res === "ckf") {
    if (name.includes("deliver")) return "CABINET_DELIVERY";
    if (name.includes("set") || name.includes("counter")) return "COUNTERTOP_SET";
  }
  return "OTHER";
}

async function getLeadTimeWeeks(itemType: ItemType, companyId: string, projectId: string): Promise<number> {
  // Check project-level override first
  const projectOverride = await db
    .collection(COLLECTIONS.leadTimeSettings(companyId))
    .where("itemType", "==", itemType)
    .where("projectId", "==", projectId)
    .limit(1)
    .get();
  if (!projectOverride.empty) return projectOverride.docs[0].data().leadTimeWeeks as number;

  // Fall back to company default
  const companyDefault = await db
    .collection(COLLECTIONS.leadTimeSettings(companyId))
    .where("itemType", "==", itemType)
    .where("isDefault", "==", true)
    .limit(1)
    .get();
  if (!companyDefault.empty) return companyDefault.docs[0].data().leadTimeWeeks as number;

  // Hard-coded fallback
  return DEFAULT_LEAD_TIMES.find((lt) => lt.itemType === itemType)?.leadTimeWeeks ?? 8;
}

interface ParsedTask {
  taskIdOriginal?: string;
  taskName: string;
  building?: string;
  floor?: string;
  startDate: string;
  endDate?: string;
  assignedResource?: string;
  isOurTask: boolean;
}

// ─── Claude extraction ────────────────────────────────────────────────────────

/**
 * Send the entire PDF in one Claude call.
 * Claude supports up to 100 pages per request on Sonnet (200k context window).
 * This replaces the old page-count + per-page loop — 1 call instead of N+1.
 */
async function extractTasksFromPdf(
  base64Pdf: string,
  companyId: string
): Promise<ParsedTask[]> {
  const message = await createMessage({
    companyId,
    action: "parse_schedule_pdf",
    model: "claude-sonnet-4-6",
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64Pdf },
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "Extract ALL tasks from every page of this construction schedule. Return the complete JSON array.",
          },
        ] as object[],
      },
    ],
  });

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const tasks = JSON.parse(cleaned) as ParsedTask[];
    logger.info("[parser] PDF: parsed output sample", {
      outputTokens: message.usage?.output_tokens,
      taskCount: tasks.length,
      firstTask: tasks[0] ?? null,
      lastTask: tasks[tasks.length - 1] ?? null,
      rawLength: cleaned.length,
    });
    return tasks;
  } catch {
    logger.warn("[parser] PDF: invalid JSON from full-document parse", { preview: cleaned.slice(0, 200) });
    return [];
  }
}

// Keep the old per-page function exported for Procore sync (text-based, not PDF)
async function extractTasksFromPdfPage(
  base64Pdf: string,
  pageNum: number,
  totalPages: number,
  companyId: string
): Promise<ParsedTask[]> {
  const message = await createMessage({
    companyId,
    action: "parse_schedule_page",
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64Pdf },
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `Extract ALL tasks from page ${pageNum} of this construction schedule. Return the JSON array.`,
          },
        ] as object[],
      },
    ],
  });

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    logger.warn(`[parser] Page ${pageNum}: invalid JSON`, { preview: cleaned.slice(0, 100) });
    return [];
  }
}

async function extractTasksFromText(rawText: string, companyId: string): Promise<ParsedTask[]> {
  const MAX_CHUNK = 12000;
  const allTasks: ParsedTask[] = [];

  const pageSplit = rawText.split(/===\s*Page\s+\d+.*?===/).filter((p) => p.trim().length > 50);
  const chunksToProcess: string[] = pageSplit.length > 1
    ? pageSplit
    : (() => {
        const result: string[] = [];
        for (let i = 0; i < rawText.length; i += MAX_CHUNK) result.push(rawText.slice(i, i + MAX_CHUNK));
        return result;
      })();

  for (const chunk of chunksToProcess) {
    const message = await createMessage({
      companyId,
      action: "parse_schedule_text",
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Parse this construction schedule and return the JSON array:\n\n${chunk}` }],
    });

    const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const cleaned = text.replace(/```json|```/g, "").trim();
    try {
      allTasks.push(...JSON.parse(cleaned));
    } catch {
      logger.warn("[parser] Invalid JSON from text chunk");
    }
  }

  return allTasks;
}

// ─── Save parsed tasks to Firestore ──────────────────────────────────────────

async function saveParsedTasks(
  tasks: ParsedTask[],
  projectId: string,
  companyId: string,
  uploadId: string
): Promise<{ tasksCreated: number; orderItemsCreated: number; chainsCreated: number; changesDetected: number }> {
  // Get previous upload for change detection
  const prevUploadsSnap = await db
    .collection(`companies/${companyId}/projects/${projectId}/scheduleUploads`)
    .orderBy("uploadedAt", "desc")
    .limit(2)
    .get();

  const prevUpload = prevUploadsSnap.docs.find((d) => d.id !== uploadId);
  let prevTasks: Array<{ taskName: string; building: string | null; floor: string | null; gcInstallDate: Timestamp }> = [];

  if (prevUpload) {
    const prevTasksSnap = await db
      .collection(`companies/${companyId}/projects/${projectId}/tasks`)
      .where("scheduleUploadId", "==", prevUpload.id)
      .get();
    prevTasks = prevTasksSnap.docs.map((d) => d.data() as any);
  }

  let tasksCreated = 0;
  let orderItemsCreated = 0;
  let chainsCreated = 0;
  let changesDetected = 0;

  const projectDoc = await db.doc(`${COLLECTIONS.projects(companyId)}/${projectId}`).get();
  const projectName = projectDoc.data()?.name as string | undefined;

  // Load team members once for all chain generation
  const teamSnap = await db.collection(COLLECTIONS.teamMembers(companyId)).get();
  const teamRoleMap = new Map<string, string>();
  for (const doc of teamSnap.docs) {
    const m = doc.data();
    if (!teamRoleMap.has(m.role)) teamRoleMap.set(m.role, doc.id);
  }

  // Deduplicate
  const seen = new Set<string>();
  const uniqueTasks = tasks.filter((t) => {
    const key = `${t.taskName}|${normalizeLabel(t.building) ?? ""}|${normalizeLabel(t.floor) ?? ""}|${t.startDate ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const noDateCount = uniqueTasks.filter((t) => !t.startDate).length;
  if (noDateCount > 0) {
    logger.warn("saveParsedTasks: skipping tasks with no startDate", {
      companyId, projectId, skipped: noDateCount, total: uniqueTasks.length,
    });
  }

  for (const t of uniqueTasks) {
    if (!t.startDate) continue;

    const category = categorizeTask(t.taskName, t.assignedResource ?? null);
    const normalizedBuilding = normalizeLabel(t.building);
    const normalizedFloor = normalizeLabel(t.floor);
    const gcInstallDate = Timestamp.fromDate(new Date(t.startDate));

    const taskRef = db.collection(`companies/${companyId}/projects/${projectId}/tasks`).doc();
    const taskData = {
      id: taskRef.id,
      projectId,
      companyId,
      scheduleUploadId: uploadId,
      taskIdOriginal: t.taskIdOriginal ?? null,
      taskName: t.taskName,
      building: normalizedBuilding,
      floor: normalizedFloor,
      gcInstallDate,
      gcInstallDateEnd: t.endDate ? Timestamp.fromDate(new Date(t.endDate)) : null,
      assignedResource: t.assignedResource ?? null,
      category,
      isOurTask: t.isOurTask,
      status: "OPEN",
      createdAt: FieldValue.serverTimestamp(),
    };

    await taskRef.set(taskData);
    tasksCreated++;

    // Detect schedule changes
    if (prevUpload) {
      const prevTask = prevTasks.find(
        (pt) =>
          pt.taskName === t.taskName &&
          normalizeLabel(pt.building) === normalizedBuilding &&
          normalizeLabel(pt.floor) === normalizedFloor
      );
      if (prevTask) {
        const prevDate = prevTask.gcInstallDate.toDate();
        const newDate = new Date(t.startDate);
        if (prevDate.toISOString() !== newDate.toISOString()) {
          const shiftDays = Math.round((newDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
          const changeRef = db.collection(`companies/${companyId}/projects/${projectId}/scheduleChanges`).doc();
          await changeRef.set({
            id: changeRef.id,
            projectId,
            companyId,
            taskId: taskRef.id,
            taskName: t.taskName,
            building: normalizedBuilding,
            floor: normalizedFloor,
            detectedAt: FieldValue.serverTimestamp(),
            previousDate: Timestamp.fromDate(prevDate),
            newDate: gcInstallDate,
            shiftDays,
            notificationsSent: false,
          });
          changesDetected++;
        }
      }
    }

    // Create order items for all tasks
    if (category === "CABINET_DELIVERY") {
      const leadTimeWeeks = await getLeadTimeWeeks("CABINETS_STANDARD", companyId, projectId);
      const orderByDate = new Date(new Date(t.startDate).getTime() - leadTimeWeeks * 7 * 24 * 60 * 60 * 1000);
      const orderRef = db.collection(`companies/${companyId}/projects/${projectId}/orderItems`).doc();
      await orderRef.set({
        id: orderRef.id,
        taskId: taskRef.id,
        projectId,
        companyId,
        itemType: "CABINETS_STANDARD",
        leadTimeWeeks,
        orderByDate: Timestamp.fromDate(orderByDate),
        orderedAt: null,
        poNumber: null,
        vendorName: null,
        notes: null,
        status: "NOT_ORDERED",
        taskName: t.taskName,
        assignedResource: t.assignedResource ?? null,
        building: normalizedBuilding,
        floor: normalizedFloor,
        gcInstallDate,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      orderItemsCreated++;
    } else if (category === "COUNTERTOP_SET") {
      const leadTimeWeeks = await getLeadTimeWeeks("COUNTERTOPS", companyId, projectId);
      const orderByDate = new Date(new Date(t.startDate).getTime() - leadTimeWeeks * 7 * 24 * 60 * 60 * 1000);
      const orderRef = db.collection(`companies/${companyId}/projects/${projectId}/orderItems`).doc();
      await orderRef.set({
        id: orderRef.id,
        taskId: taskRef.id,
        projectId,
        companyId,
        itemType: "COUNTERTOPS",
        leadTimeWeeks,
        orderByDate: Timestamp.fromDate(orderByDate),
        orderedAt: null,
        poNumber: null,
        vendorName: null,
        notes: null,
        status: "NOT_ORDERED",
        taskName: t.taskName,
        assignedResource: t.assignedResource ?? null,
        building: normalizedBuilding,
        floor: normalizedFloor,
        gcInstallDate,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      orderItemsCreated++;
    } else {
      // CABINET_INSTALL, OTHER — use TRADE_MATERIALS
      const leadTimeWeeks = await getLeadTimeWeeks("TRADE_MATERIALS", companyId, projectId);
      const orderByDate = new Date(new Date(t.startDate).getTime() - leadTimeWeeks * 7 * 24 * 60 * 60 * 1000);
      const orderRef = db.collection(`companies/${companyId}/projects/${projectId}/orderItems`).doc();
      await orderRef.set({
        id: orderRef.id,
        taskId: taskRef.id,
        projectId,
        companyId,
        itemType: "TRADE_MATERIALS",
        leadTimeWeeks,
        orderByDate: Timestamp.fromDate(orderByDate),
        orderedAt: null,
        poNumber: null,
        vendorName: null,
        notes: null,
        status: "NOT_ORDERED",
        taskName: t.taskName,
        assignedResource: t.assignedResource ?? null,
        building: normalizedBuilding,
        floor: normalizedFloor,
        gcInstallDate,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      orderItemsCreated++;
    }

    // Generate task chain for every task (keyed by taskRef.id — unique per task per upload)
    const ltWeeks = category === "COUNTERTOP_SET"
      ? await getLeadTimeWeeks("COUNTERTOPS", companyId, projectId)
      : category === "CABINET_DELIVERY"
        ? await getLeadTimeWeeks("CABINETS_STANDARD", companyId, projectId)
        : await getLeadTimeWeeks("TRADE_MATERIALS", companyId, projectId);

    await generateTaskChain({
      projectId,
      companyId,
      building: normalizedBuilding,
      floor: normalizedFloor,
      taskId: taskRef.id,
      taskName: t.taskName,
      assignedResource: t.assignedResource ?? null,
      installDate: new Date(t.startDate),
      leadTimeWeeks: ltWeeks,
      projectName,
      teamRoleMap,
    });
    chainsCreated++;
  }

  // Mark upload as parsed
  await db.doc(`companies/${companyId}/projects/${projectId}/scheduleUploads/${uploadId}`).update({
    parsedAt: FieldValue.serverTimestamp(),
  });

  // Update project alert counts (denormalized)
  await updateProjectAlertCounts(projectId, companyId);

  return { tasksCreated, orderItemsCreated, chainsCreated, changesDetected };
}

// ─── Task chain generator ─────────────────────────────────────────────────────

const STEP_ROLE_MAP: Record<string, string> = {
  SHOP_DRAWINGS: "DRAFTING",
  SUBMISSIONS: "DRAFTING",
  ORDER_MATERIALS: "PURCHASING",
  CONFIRM_DELIVERY: "PURCHASING",
  INSTALL: "INSTALLER",
  PUNCH_LIST: "SUPERVISOR",
};

// GC = only GC team members can update, SUB = only sub can update, BOTH = either can update
const STEP_CAN_EDIT_BY: Record<string, string> = {
  SHOP_DRAWINGS: "GC",
  SUBMISSIONS: "GC",
  ORDER_MATERIALS: "BOTH",
  CONFIRM_DELIVERY: "SUB",
  INSTALL: "SUB",
  PUNCH_LIST: "SUB",
};

async function generateTaskChain(input: {
  projectId: string;
  companyId: string;
  building: string | null;
  floor: string | null;
  taskId: string;
  taskName: string;
  assignedResource: string | null;
  installDate: Date;
  leadTimeWeeks: number;
  projectName?: string;
  teamRoleMap: Map<string, string>;
}): Promise<void> {
  const { projectId, companyId, building, floor, taskId, taskName, assignedResource, installDate, leadTimeWeeks, projectName, teamRoleMap } = input;

  const orderByDate = new Date(installDate.getTime() - leadTimeWeeks * 7 * 24 * 60 * 60 * 1000);
  const confirmByDate = new Date(installDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const punchDate = new Date(installDate.getTime() + 3 * 24 * 60 * 60 * 1000);

  const steps = [
    { stepType: "SHOP_DRAWINGS", dueDate: null, track: "CONTRACT", dependsOnIdx: null },
    { stepType: "SUBMISSIONS", dueDate: null, track: "CONTRACT", dependsOnIdx: 0 },
    { stepType: "ORDER_MATERIALS", dueDate: orderByDate, track: "SCHEDULE", dependsOnIdx: null },
    { stepType: "CONFIRM_DELIVERY", dueDate: confirmByDate, track: "SCHEDULE", dependsOnIdx: 2 },
    { stepType: "INSTALL", dueDate: installDate, track: "SCHEDULE", dependsOnIdx: 3 },
    { stepType: "PUNCH_LIST", dueDate: punchDate, track: "SCHEDULE", dependsOnIdx: 4 },
  ];

  const stepIds: string[] = [];
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ref = db.collection(`companies/${companyId}/projects/${projectId}/taskSteps`).doc();
    stepIds.push(ref.id);

    batch.set(ref, {
      id: ref.id,
      projectId,
      companyId,
      taskId,
      taskName,
      assignedResource,
      building,
      floor,
      projectName: projectName ?? null,
      stepType: s.stepType,
      canEditBy: STEP_CAN_EDIT_BY[s.stepType] ?? "GC",
      assignedToId: teamRoleMap.get(STEP_ROLE_MAP[s.stepType]) ?? null,
      dueDate: s.dueDate ? Timestamp.fromDate(s.dueDate) : null,
      completedAt: null,
      status: "PENDING",
      notes: null,
      track: s.track,
      dependsOnId: s.dependsOnIdx !== null ? stepIds[s.dependsOnIdx] : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  await batch.commit();
}

// ─── Alert count updater ──────────────────────────────────────────────────────

async function updateProjectAlertCounts(projectId: string, companyId: string): Promise<void> {
  const ordersSnap = await db
    .collection(`companies/${companyId}/projects/${projectId}/orderItems`)
    .get();

  const today = new Date();
  let critical = 0;
  let warning = 0;

  for (const doc of ordersSnap.docs) {
    const item = doc.data();
    if (item.status === "DELIVERED" || item.status === "CANCELLED") continue;
    if (item.status === "IN_TRANSIT" || item.status === "ORDERED") continue;

    const orderByDate = item.orderByDate?.toDate ? item.orderByDate.toDate() : new Date(item.orderByDate);
    const daysUntil = Math.ceil((orderByDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntil < 0) critical++;
    else if (daysUntil <= 14) warning++;
  }

  await db.doc(`companies/${companyId}/projects/${projectId}`).update({
    alertCounts: { critical, warning },
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ─── Cloud Function ───────────────────────────────────────────────────────────

export const schedulesUploadApi = functions.runWith({ timeoutSeconds: 300, memory: "512MB", secrets: ["ANTHROPIC_API_KEY"] }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    const authHeader = req.headers.authorization;
    logger.info("schedulesUploadApi: incoming request", {
      method: req.method,
      hasAuthHeader: !!authHeader,
      authHeaderPrefix: authHeader ? authHeader.slice(0, 15) : "none",
      origin: req.headers.origin,
    });

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("schedulesUploadApi: auth failed", { msg });
      replyUnauthorized(res); return;
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      res.status(503).json({ error: "ANTHROPIC_API_KEY not configured. Cannot parse schedule." });
      return;
    }

    // ── Parse multipart/form-data with busboy ──────────────────────────────
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      replyBadRequest(res, "Request must be multipart/form-data.");
      return;
    }

    let fileBuffer: Buffer | null = null;
    let fileName = "schedule";
    // projectId may come from the form fields (multipart) or query string
    let fileProjectId: string | undefined = (req.query?.projectId as string | undefined);
    let fileGcCompanyId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB cap

      bb.on("file", (_field: string, stream: NodeJS.ReadableStream, info: { filename: string }) => {
        fileName = info.filename || "schedule";
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
        stream.on("error", reject);
      });

      bb.on("field", (name: string, value: string) => {
        if (name === "projectId") fileProjectId = value;
        if (name === "gcCompanyId") fileGcCompanyId = value;
      });

      bb.on("finish", resolve);
      bb.on("error", reject);

      // Firebase Functions buffers the entire request body before invoking the
      // handler, so req is already ended by the time we get here. Piping req
      // directly causes busboy to see "Unexpected end of form". Instead, write
      // the pre-buffered rawBody and close the stream manually.
      const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (rawBody) {
        bb.write(rawBody);
        bb.end();
      } else {
        req.pipe(bb);
      }
    });

    if (!fileBuffer || (fileBuffer as Buffer).length === 0) {
      replyBadRequest(res, "No file received."); return;
    }

    const buffer = fileBuffer as Buffer;
    const resolvedProjectId = fileProjectId;
    if (!resolvedProjectId) { replyBadRequest(res, "projectId is required."); return; }

    // ── Resolve effective company ID (sub uploads route through GC path) ─────
    let uploadCompanyId = companyId;

    if (fileGcCompanyId && fileGcCompanyId !== companyId) {
      // Sub upload: verify active projectConnection before allowing
      const connectionId = `${resolvedProjectId}_${companyId}`;
      const connSnap = await db
        .doc(`${COLLECTIONS.projectConnections(fileGcCompanyId)}/${connectionId}`)
        .get();
      if (!connSnap.exists || connSnap.data()?.status !== "ACTIVE") {
        res.status(403).json({ error: "Not connected to this project." }); return;
      }
      uploadCompanyId = fileGcCompanyId;
    }

    // ── Verify project exists and belongs to the resolved company ──────────
    const projectRef = db.doc(`${COLLECTIONS.projects(uploadCompanyId)}/${resolvedProjectId}`);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists || projectSnap.data()?.companyId !== uploadCompanyId) {
      res.status(404).json({ error: "Project not found." }); return;
    }

    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const isPdf = ext === "pdf";
    const isXlsx = ext === "xlsx" || ext === "xls";
    const isText = ext === "csv" || ext === "txt" || ext === "text";

    if (!isPdf && !isXlsx && !isText) {
      replyBadRequest(res, "Unsupported file type. Use PDF, XLSX, CSV, or TXT."); return;
    }

    logger.info("schedules/upload: file received", { uploadCompanyId, callerCompanyId: companyId, projectId: resolvedProjectId, fileName, bytes: buffer.length });

    // ── Determine upload version ───────────────────────────────────────────
    const uploadsSnap = await db
      .collection(`companies/${uploadCompanyId}/projects/${resolvedProjectId}/scheduleUploads`)
      .orderBy("uploadedAt", "desc")
      .limit(1)
      .get();
    const version = uploadsSnap.empty ? 1 : (uploadsSnap.docs[0].data().version as number ?? 0) + 1;

    // ── Create upload record ───────────────────────────────────────────────
    const uploadRef = db.collection(`companies/${uploadCompanyId}/projects/${resolvedProjectId}/scheduleUploads`).doc();
    const now = FieldValue.serverTimestamp();
    const rawText = isPdf ? "[PDF — parsed via vision]" : buffer.toString("utf-8");

    await uploadRef.set({
      id: uploadRef.id,
      projectId: resolvedProjectId,
      companyId: uploadCompanyId,
      uploadedByCompanyId: companyId,
      fileName,
      rawText,
      version,
      uploadedAt: now,
      parsedAt: null,
    });

    // ── Extract tasks ──────────────────────────────────────────────────────
    let tasks: ParsedTask[] = [];

    if (isPdf) {
      const base64 = buffer.toString("base64");

      // Single Claude call for the entire PDF — no page-count pre-flight needed.
      // Sonnet supports up to 100 pages per request within its 200k context window.
      logger.info("schedules/upload: sending full PDF to Claude", { uploadCompanyId });
      tasks = await extractTasksFromPdf(base64, uploadCompanyId);
    } else {
      tasks = await extractTasksFromText(rawText, uploadCompanyId);
    }

    // ── Save to Firestore ──────────────────────────────────────────────────
    const result = await saveParsedTasks(tasks, resolvedProjectId, uploadCompanyId, uploadRef.id);

    // ── Send change notifications if this is a re-upload ──────────────────
    if (version > 1 && result.changesDetected > 0) {
      const resend = getResend();
      if (resend) {
        try {
          const projectSnap = await db.doc(`${COLLECTIONS.projects(uploadCompanyId)}/${resolvedProjectId}`).get();
          const notifProjectName = projectSnap.data()?.name ?? "Project";
          const subject = `Schedule updated: ${notifProjectName} — ${result.changesDetected} change${result.changesDetected !== 1 ? "s" : ""}`;

          const changesSnap = await db
            .collection(`companies/${uploadCompanyId}/projects/${resolvedProjectId}/scheduleChanges`)
            .orderBy("detectedAt", "desc")
            .limit(50)
            .get();
          const recentChanges: ScheduleChangeItem[] = changesSnap.docs.map((d) => {
            const c = d.data();
            return {
              taskName: c.taskName ?? "",
              building: c.building ?? null,
              floor: c.floor ?? null,
              previousDate: c.previousDate?.toDate?.() ?? new Date(),
              newDate: c.newDate?.toDate?.() ?? new Date(),
              shiftDays: c.shiftDays ?? 0,
            };
          });
          const notifHtml = buildScheduleChangeEmailHtml(recentChanges, notifProjectName);

          // GC team notifications
          const gcTeamSnap = await db.collection(COLLECTIONS.teamMembers(uploadCompanyId)).get();
          const gcRecipients = gcTeamSnap.docs
            .map((d) => d.data())
            .filter((m) => m.notifyOnScheduleChange && m.email);
          for (const member of gcRecipients) {
            await resend.emails.send({ from: FROM, to: member.email, subject, html: notifHtml });
          }

          // Connected sub notifications
          const connectionsSnap = await db.collection(COLLECTIONS.projectConnections(uploadCompanyId)).get();
          const activeConns = connectionsSnap.docs.filter(
            (d) => d.id.startsWith(resolvedProjectId + "_") && d.data().status === "ACTIVE"
          );
          let subRecipientCount = 0;
          for (const conn of activeConns) {
            const subCompanyId = conn.data().subCompanyId as string;
            const subTeamSnap = await db.collection(COLLECTIONS.teamMembers(subCompanyId)).get();
            const subRecipients = subTeamSnap.docs
              .map((d) => d.data())
              .filter((m) => m.notifyOnScheduleChange && m.email);
            for (const member of subRecipients) {
              await resend.emails.send({ from: FROM, to: member.email, subject, html: notifHtml });
              subRecipientCount++;
            }
          }

          logger.info("schedules/upload: change notifications sent", {
            uploadCompanyId, gcRecipients: gcRecipients.length, subRecipients: subRecipientCount,
          });
        } catch (emailErr) {
          logger.warn("schedules/upload: failed to send change notifications", { error: String(emailErr) });
        }
      }
    }

    logger.info("schedules/upload: complete", { uploadCompanyId, projectId: resolvedProjectId, ...result, version });

    res.json({ ...result, version });
  });
});

// Export helpers for use by other modules (Procore sync, from-schedule)
export { saveParsedTasks, extractTasksFromText, extractTasksFromPdf, extractTasksFromPdfPage, updateProjectAlertCounts, generateTaskChain };
