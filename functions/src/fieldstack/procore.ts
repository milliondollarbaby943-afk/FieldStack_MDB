/**
 * Procore integration Cloud Functions.
 * - OAuth2 callback (exchanges code for tokens, saves to project)
 * - Webhook receiver (real-time schedule change events)
 * - Manual sync trigger
 * - Nightly cron sync
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import cors from "cors";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest } from "./middleware";
import { COLLECTIONS } from "./types";
import { extractTasksFromText, saveParsedTasks, updateProjectAlertCounts } from "./schedules";
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
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const PROCORE_API_BASE = "https://api.procore.com/rest/v1.0";

// ─── Token helpers ────────────────────────────────────────────────────────────

async function refreshProcoreToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const res = await fetch("https://login.procore.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.PROCORE_CLIENT_ID,
      client_secret: process.env.PROCORE_CLIENT_SECRET,
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error("Procore token refresh failed");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function getValidProcoreToken(project: admin.firestore.DocumentData, projectRef: admin.firestore.DocumentReference): Promise<string | null> {
  if (!project.procoreAccessToken) return null;

  // Refresh if expired (with 5 min buffer)
  if (project.procoreTokenExpiry) {
    const expiry = project.procoreTokenExpiry.toDate ? project.procoreTokenExpiry.toDate() : new Date(project.procoreTokenExpiry);
    if (expiry.getTime() < Date.now() + 300000) {
      if (!project.procoreRefreshToken) return null;
      try {
        const tokens = await refreshProcoreToken(project.procoreRefreshToken);
        await projectRef.update({
          procoreAccessToken: tokens.access_token,
          procoreRefreshToken: tokens.refresh_token,
          procoreTokenExpiry: Timestamp.fromMillis(tokens.expires_at),
        });
        return tokens.access_token;
      } catch {
        logger.error("Procore token refresh failed", { projectId: projectRef.id });
        return null;
      }
    }
  }

  return project.procoreAccessToken as string;
}

// ─── Fetch schedule from Procore ──────────────────────────────────────────────

async function fetchProcoreSchedule(
  project: admin.firestore.DocumentData,
  projectRef: admin.firestore.DocumentReference
): Promise<{ rawText: string; fileName: string } | null> {
  if (project.gcPlatform !== "PROCORE" || !project.gcProjectId) return null;

  const token = await getValidProcoreToken(project, projectRef);
  if (!token) return null;

  try {
    const res = await fetch(
      `${PROCORE_API_BASE}/projects/${project.gcProjectId}/schedule/tasks`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      logger.error("Procore API error", { status: res.status });
      return null;
    }

    const tasks = await res.json() as any[];
    const lines = tasks.map((t: any) =>
      `${t.id}\t${t.name}\t${t.assigned_to?.name || ""}\t${t.start_date || ""}\t${t.finish_date || ""}\t${t.location?.name || ""}`
    );

    const header = `Procore Schedule Export\nProject: ${project.name}\nExported: ${new Date().toISOString()}\n\nID\tTask Name\tResource\tStart\tEnd\tLocation\n`;
    return {
      rawText: header + lines.join("\n"),
      fileName: `procore-sync-${new Date().toISOString().slice(0, 10)}.txt`,
    };
  } catch (err) {
    logger.error("Procore fetch error", { error: String(err) });
    return null;
  }
}

// ─── Full sync pipeline ───────────────────────────────────────────────────────

async function syncProcoreSchedule(projectId: string, companyId: string): Promise<{
  success: boolean;
  tasksCreated?: number;
  orderItemsCreated?: number;
  changesDetected?: number;
  error?: string;
}> {
  const projectRef = db.doc(`${COLLECTIONS.projects(companyId)}/${projectId}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) return { success: false, error: "Project not found" };

  const project = projectSnap.data()!;
  const scheduleData = await fetchProcoreSchedule(project, projectRef);
  if (!scheduleData) return { success: false, error: "Could not fetch schedule from Procore" };

  // Determine version
  const uploadsSnap = await db
    .collection(`${COLLECTIONS.projects(companyId)}/${projectId}/scheduleUploads`)
    .orderBy("version", "desc")
    .limit(1)
    .get();
  const version = (uploadsSnap.docs[0]?.data()?.version ?? 0) + 1;

  // Save upload record
  const uploadRef = db.collection(`${COLLECTIONS.projects(companyId)}/${projectId}/scheduleUploads`).doc();
  await uploadRef.set({
    id: uploadRef.id,
    projectId,
    companyId,
    fileName: scheduleData.fileName,
    rawText: scheduleData.rawText,
    version,
    uploadedAt: FieldValue.serverTimestamp(),
    parsedAt: null,
  });

  // Parse with Claude
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return { success: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  const tasks = await extractTasksFromText(scheduleData.rawText, companyId);
  const result = await saveParsedTasks(tasks, projectId, companyId, uploadRef.id);

  // Update last sync time
  await projectRef.update({ procoreLastSync: FieldValue.serverTimestamp() });

  return { success: true, ...result };
}

// ─── OAuth2 callback ──────────────────────────────────────────────────────────

export const procoreCallbackApi = functions.https.onRequest(async (req, res) => {
  const code = req.query.code as string;
  const state = req.query.state as string; // projectId_companyId

  const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

  if (!code || !state) {
    res.redirect(`${FRONTEND_URL}/dashboard?error=procore_auth_failed`);
    return;
  }

  const [projectId, companyId] = state.split("_");
  if (!projectId || !companyId) {
    res.redirect(`${FRONTEND_URL}/dashboard?error=procore_auth_failed`);
    return;
  }

  try {
    const tokenRes = await fetch("https://login.procore.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: process.env.PROCORE_CLIENT_ID,
        client_secret: process.env.PROCORE_CLIENT_SECRET,
        redirect_uri: `${process.env.APP_URL}/api/procore/callback`,
      }),
    });

    const tokens = await tokenRes.json() as any;
    if (!tokenRes.ok) throw new Error(tokens.error_description ?? "Procore auth failed");

    await db.doc(`${COLLECTIONS.projects(companyId)}/${projectId}`).update({
      procoreAccessToken: tokens.access_token,
      procoreRefreshToken: tokens.refresh_token,
      procoreTokenExpiry: Timestamp.fromMillis(Date.now() + tokens.expires_in * 1000),
      autoSyncEnabled: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.redirect(`${FRONTEND_URL}/projects/${projectId}?tab=Settings&procore=connected`);
  } catch (err) {
    logger.error("Procore OAuth callback error", { error: String(err) });
    res.redirect(`${FRONTEND_URL}/projects/${projectId}?tab=Settings&procore=error`);
  }
});

// ─── Webhook receiver ─────────────────────────────────────────────────────────

export const procoreWebhookApi = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

  try {
    const body = req.body;

    // Procore sends a verification challenge on webhook setup
    if (body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    const { resource_name, event_type, project_id } = body;

    if (resource_name !== "Schedule" && resource_name !== "Tasks") {
      res.json({ ignored: true });
      return;
    }

    logger.info("Procore webhook received", { resource_name, event_type, project_id });

    // Find our project by gcProjectId
    const projectsSnap = await db
      .collectionGroup("projects")
      .where("gcProjectId", "==", String(project_id))
      .where("gcPlatform", "==", "PROCORE")
      .where("autoSyncEnabled", "==", true)
      .limit(1)
      .get();

    if (projectsSnap.empty) {
      res.json({ ignored: true, reason: "no matching project" });
      return;
    }

    const projectDoc = projectsSnap.docs[0];
    const project = projectDoc.data();
    const companyId = project.companyId as string;

    // Debounce: skip if synced within 5 minutes
    if (project.procoreLastSync) {
      const lastSync = project.procoreLastSync.toDate();
      const minutesSince = (Date.now() - lastSync.getTime()) / 60000;
      if (minutesSince < 5) {
        res.json({ debounced: true });
        return;
      }
    }

    const result = await syncProcoreSchedule(projectDoc.id, companyId);
    res.json(result);
  } catch (err) {
    logger.error("Procore webhook error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ─── Manual sync ──────────────────────────────────────────────────────────────

export const procoreSyncApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const { projectId } = req.body ?? {};
    if (!projectId) { replyBadRequest(res, "projectId is required."); return; }

    const result = await syncProcoreSchedule(projectId, companyId);
    res.json(result);
  });
});

// ─── Nightly sync (company-level, checks integration tokens) ─────────────────

export const procoreNightlySync = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (_context) => {
    logger.info("procoreNightlySync triggered");

    const companiesSnap = await db
      .collection("companies")
      .where("companyType", "==", "GC")
      .get();

    logger.info(`procoreNightlySync: ${companiesSnap.size} GC companies to check`);

    const results: Array<{ companyId: string; projectId: string; success: boolean }> = [];

    for (const companyDoc of companiesSnap.docs) {
      const companyId = companyDoc.id;

      // Check if this company has a connected Procore integration
      const integrationSnap = await db
        .collection(`companies/${companyId}/integrations`)
        .doc("procore")
        .get();

      if (!integrationSnap.exists || integrationSnap.data()?.status !== "connected") {
        continue;
      }

      // Query all projects for this company that have a procoreProjectId
      const projectsSnap = await db
        .collection(COLLECTIONS.projects(companyId))
        .where("procoreProjectId", "!=", null)
        .get();

      for (const projectDoc of projectsSnap.docs) {
        const projectId = projectDoc.id;
        const procoreProjectId = projectDoc.data().procoreProjectId as string;
        const projectRef = projectDoc.ref;

        try {
          await syncProcoreSchedule(projectId, companyId);
          await projectRef.update({
            lastSyncedAt: FieldValue.serverTimestamp(),
            syncStatus: "synced",
          });
          results.push({ companyId, projectId, success: true });
        } catch (err) {
          logger.error("procoreNightlySync: project sync failed", {
            companyId,
            projectId,
            procoreProjectId,
            error: String(err),
          });
          try {
            await projectRef.update({ syncStatus: "error" });
          } catch (updateErr) {
            logger.error("procoreNightlySync: failed to write syncStatus=error", {
              companyId,
              projectId,
              error: String(updateErr),
            });
          }
          results.push({ companyId, projectId, success: false });
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    logger.info(`procoreNightlySync complete: ${succeeded} synced, ${failed} failed`, { results });
  });

// ─── Nightly cron ─────────────────────────────────────────────────────────────

export const procoreSyncCron = functions.pubsub
  .schedule("0 11 * * *") // 11am UTC (6am CT)
  .timeZone("UTC")
  .onRun(async (_context) => {
    logger.info("procoreSyncCron triggered");

    const projectsSnap = await db
      .collectionGroup("projects")
      .where("gcPlatform", "==", "PROCORE")
      .where("autoSyncEnabled", "==", true)
      .where("status", "==", "ACTIVE")
      .get();

    logger.info(`Procore nightly sync: ${projectsSnap.size} projects`);

    for (const doc of projectsSnap.docs) {
      const project = doc.data();
      if (!project.procoreAccessToken) continue;
      try {
        await syncProcoreSchedule(doc.id, project.companyId);
      } catch (err) {
        logger.error("Procore sync failed", { projectId: doc.id, error: String(err) });
      }
    }
  });
