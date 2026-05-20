/**
 * Create project from schedule — drop a PDF/XLSX/TXT and get a project + parsed tasks in one shot.
 * A single Claude call extracts project metadata AND all tasks together.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import cors from "cors";
import Busboy from "busboy";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest } from "./middleware";
import { COLLECTIONS, DEFAULT_LEAD_TIMES } from "./types";
import { createMessage } from "./anthropic";
import { saveParsedTasks } from "./schedules";
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

// ─── Combined extraction ──────────────────────────────────────────────────────

interface ExtractedProjectInfo {
  projectName: string;
  address: string;
  gcName: string;
  gcContact?: string;
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

interface ScheduleExtraction {
  project: ExtractedProjectInfo;
  tasks: ParsedTask[];
}

const COMBINED_SYSTEM_PROMPT = `You are a construction schedule parser for a cabinet and countertop subcontractor.

From the provided construction schedule document, extract TWO things in a single JSON response:

1. PROJECT METADATA — from the document header, title block, or letterhead.
2. ALL TASKS — every task on every page, no trade skipped.

For tasks, set "isOurTask" to true ONLY if the task relates to cabinets, countertops, or backsplash (assigned to CKF, BAM, or explicitly mentions those items). All other tasks get "isOurTask": false.

CRITICAL for dates: extract start and end dates for every task. Dates may appear as "Apr 1", "04/01/26", "Mar 23, 2026", or as Gantt-style bars. Normalize to YYYY-MM-DD. Infer the year from context if not shown. Include tasks even if no date is identifiable (use best estimate for startDate).

Return ONLY valid JSON — no prose, no markdown fences, no explanation — matching this exact shape:
{
  "project": {
    "projectName": "string",
    "address": "string or empty",
    "gcName": "general contractor company name",
    "gcContact": "superintendent or contact name or empty"
  },
  "tasks": [
    {
      "taskIdOriginal": "ID or null",
      "taskName": "exact name",
      "building": "Building X or null",
      "floor": "Floor Y or null",
      "startDate": "YYYY-MM-DD",
      "endDate": "YYYY-MM-DD or null",
      "assignedResource": "company or null",
      "isOurTask": false
    }
  ]
}`;

async function extractSchedule(
  input: string | { base64: string },
  companyId: string
): Promise<ScheduleExtraction> {
  const isPdf = typeof input !== "string";

  const userContent = isPdf
    ? [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: (input as { base64: string }).base64 },
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "Extract the project metadata and ALL tasks from every page of this construction schedule. Return the combined JSON object.",
        },
      ]
    : [
        {
          type: "text",
          text: `Extract the project metadata and ALL tasks from this construction schedule. Return the combined JSON object.\n\n${input as string}`,
        },
      ];

  const message = await createMessage({
    companyId,
    action: "extract_schedule",
    model: "claude-sonnet-4-6",
    max_tokens: 64000,
    system: COMBINED_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent as object[] }],
  });

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as ScheduleExtraction;
    const result = {
      project: parsed.project ?? { projectName: "New Project", address: "", gcName: "Unknown GC" },
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
    logger.info("from-schedule: parsed output sample", {
      outputTokens: message.usage?.output_tokens,
      taskCount: result.tasks.length,
      firstTask: result.tasks[0] ?? null,
      lastTask: result.tasks[result.tasks.length - 1] ?? null,
      rawLength: cleaned.length,
      project: result.project,
    });
    return result;
  } catch {
    logger.warn("from-schedule: failed to parse combined JSON", { preview: cleaned.slice(0, 300) });
    return {
      project: { projectName: "New Project", address: "", gcName: "Unknown GC" },
      tasks: [],
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectNameFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "New Project";
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

export const fromScheduleApi = functions.runWith({ timeoutSeconds: 300, memory: "512MB", secrets: ["ANTHROPIC_API_KEY"] }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      replyBadRequest(res, "ANTHROPIC_API_KEY not configured. Cannot parse schedule.");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      replyBadRequest(res, "Request must be multipart/form-data.");
      return;
    }

    let fileBuffer: Buffer | null = null;
    let fileName = "schedule";

    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });

      bb.on("file", (_field: string, stream: NodeJS.ReadableStream, info: { filename: string }) => {
        fileName = info.filename || "schedule";
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
        stream.on("error", reject);
      });

      bb.on("finish", resolve);
      bb.on("error", reject);

      // Firebase Functions pre-buffers the entire request body before invoking
      // the handler, so req is already ended. Use rawBody directly instead of
      // piping req, which would cause busboy to see "Unexpected end of form".
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
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
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const isPdf = ext === "pdf";

    logger.info("from-schedule: file received", { companyId, fileName, bytes: buffer.length });

    const result = await createProjectFromSchedule({ companyId, fileName, buffer, isPdf });

    logger.info("from-schedule: complete", { companyId, ...result });

    res.json(result);
  });
});

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Create a project and parse its schedule from a file buffer.
 * Uses a single Claude call to extract both project metadata and all tasks.
 */
export async function createProjectFromSchedule(params: {
  companyId: string;
  fileName: string;
  buffer: Buffer;
  isPdf: boolean;
}): Promise<{
  projectId: string;
  tasksCreated: number;
  orderItemsCreated: number;
  chainsCreated: number;
}> {
  const { companyId, fileName, buffer, isPdf } = params;

  if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
    throw new Error("Excel files (.xlsx/.xls) are not yet supported. Please export as CSV or PDF and re-upload.");
  }

  // ── Single Claude call for everything ─────────────────────────────────────
  const callStart = Date.now();
  logger.info("from-schedule: starting combined Claude extraction", { companyId, fileName, isPdf });

  const input: string | { base64: string } = isPdf
    ? { base64: buffer.toString("base64") }
    : buffer.toString("utf-8");

  const { project: info, tasks } = await extractSchedule(input, companyId);

  logger.info("from-schedule: Claude extraction complete", {
    companyId,
    elapsedMs: Date.now() - callStart,
    tasksFound: tasks.length,
    projectName: info.projectName,
  });

  // ── Create project ─────────────────────────────────────────────────────────
  const projectRef = db.collection(COLLECTIONS.projects(companyId)).doc();
  const now = FieldValue.serverTimestamp();

  await projectRef.set({
    id: projectRef.id,
    companyId,
    name: info.projectName || projectNameFromFilename(fileName),
    address: info.address || "",
    gcName: info.gcName || "Unknown GC",
    gcContact: info.gcContact || null,
    gcEmail: null,
    gcPlatform: null,
    gcProjectUrl: null,
    gcProjectId: null,
    procoreAccessToken: null,
    procoreRefreshToken: null,
    procoreTokenExpiry: null,
    procoreLastSync: null,
    autoSyncEnabled: false,
    status: "ACTIVE",
    alertCounts: { critical: 0, warning: 0 },
    createdAt: now,
    updatedAt: now,
  });

  // ── Seed lead times if first project for this company ─────────────────────
  const ltSnap = await db.collection(COLLECTIONS.leadTimeSettings(companyId)).limit(1).get();
  if (ltSnap.empty) {
    for (const lt of DEFAULT_LEAD_TIMES) {
      const ltRef = db.collection(COLLECTIONS.leadTimeSettings(companyId)).doc();
      await ltRef.set({
        id: ltRef.id,
        companyId,
        itemType: lt.itemType,
        label: lt.label,
        leadTimeWeeks: lt.leadTimeWeeks,
        isDefault: true,
        projectId: null,
        createdAt: now,
      });
    }
  }

  // ── Create upload record ───────────────────────────────────────────────────
  const rawText = isPdf ? "[PDF — parsed via vision]" : (input as string);
  const uploadRef = db.collection(`${COLLECTIONS.projects(companyId)}/${projectRef.id}/scheduleUploads`).doc();
  await uploadRef.set({
    id: uploadRef.id,
    projectId: projectRef.id,
    companyId,
    fileName,
    rawText,
    version: 1,
    uploadedAt: now,
    parsedAt: null,
  });

  // ── Save tasks ─────────────────────────────────────────────────────────────
  const result = await saveParsedTasks(tasks, projectRef.id, companyId, uploadRef.id);

  return { projectId: projectRef.id, ...result };
}
