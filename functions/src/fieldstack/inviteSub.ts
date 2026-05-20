/**
 * Sub-company invite flow.
 *
 * inviteSubApi   — POST /api/projects/{id}/invite-sub
 *   GC creates a pending projectConnection and sends an invite email.
 *
 * inviteAcceptApi — GET  /api/invite/accept?token=...
 *                 — POST /api/invite/accept  (body: { token })
 *   GET  returns invite metadata for the accept page.
 *   POST activates the connection once the sub user is authenticated.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import cors from "cors";
import * as crypto from "crypto";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest, replyNotFound } from "./middleware";
import { COLLECTIONS } from "./types";
import { logger } from "../logger";
import { Resend } from "resend";

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

// ─── Token helpers ─────────────────────────────────────────────────────────────

const TOKEN_EXPIRY_DAYS = 7;

interface InviteTokenPayload {
  connectionId: string;
  gcCompanyId: string;
  gcProjectId: string;
  subEmail: string;
  exp: number;
}

function getSecret(): string {
  return process.env.INVITE_SECRET ?? process.env.MAGIC_LINK_SECRET ?? "dev-invite-secret";
}

function createInviteToken(payload: Omit<InviteTokenPayload, "exp">): string {
  const full: InviteTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 86400,
  };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyInviteToken(token: string): InviteTokenPayload | null {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = crypto.createHmac("sha256", getSecret()).update(data).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as InviteTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Email ─────────────────────────────────────────────────────────────────────

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

const APP_NAME = process.env.APP_NAME ?? "FieldStack";
const FROM = `${APP_NAME} <${process.env.EMAIL_FROM ?? "noreply@example.com"}>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildInviteEmailHtml(params: {
  gcCompanyName: string;
  projectName: string;
  acceptUrl: string;
}): string {
  const { gcCompanyName, projectName, acceptUrl } = params;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>You're invited to FieldStack</title></head>
<body style="background:#0f0f11;margin:0;padding:24px;font-family:system-ui,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:#17171a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;">
      <div style="background:#0f3460;padding:20px 24px;">
        <div style="color:#c8f04c;font-family:monospace;font-size:18px;font-weight:bold;letter-spacing:0.08em;">FIELDSTACK</div>
        <div style="color:#93c5fd;font-size:13px;margin-top:4px;">Sub-Contractor Invitation</div>
      </div>
      <div style="padding:28px 24px;">
        <p style="color:#f0eff5;font-size:15px;margin:0 0 16px;">
          <strong>${escapeHtml(gcCompanyName)}</strong> has invited your company to collaborate on
          <strong>${escapeHtml(projectName)}</strong> via FieldStack.
        </p>
        <p style="color:#7a7885;font-size:13px;margin:0 0 28px;line-height:1.6;">
          Accept the invitation to connect your company, view project tasks assigned to you,
          and coordinate with the general contractor in real time.
        </p>
        <div style="text-align:center;margin-bottom:28px;">
          <a href="${acceptUrl}" style="background:#c8f04c;color:#0f0f11;padding:12px 28px;border-radius:6px;text-decoration:none;font-family:monospace;font-size:13px;font-weight:bold;display:inline-block;">Accept Invitation →</a>
        </div>
        <div style="background:#1e1e22;border-radius:6px;padding:12px 16px;">
          <p style="color:#7a7885;font-size:11px;font-family:monospace;margin:0 0 4px;">Or copy this link:</p>
          <a href="${acceptUrl}" style="color:#93c5fd;font-size:11px;font-family:monospace;word-break:break-all;text-decoration:none;">${acceptUrl}</a>
        </div>
        <p style="color:#4a4a55;font-size:11px;font-family:monospace;margin:20px 0 0;text-align:center;">
          This invitation expires in ${TOKEN_EXPIRY_DAYS} days. If you did not expect this, you can safely ignore it.
        </p>
      </div>
      <div style="padding:12px 24px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
        <span style="color:#7a7885;font-size:11px;font-family:monospace;">FieldStack · Schedule Intelligence Platform</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ─── inviteSubApi ─────────────────────────────────────────────────────────────

export const inviteSubApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed." }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const pathMatch = req.path.match(/\/([^/]+)\/invite-sub$/);
    const projectId = pathMatch?.[1];
    if (!projectId) { replyBadRequest(res, "Project ID required."); return; }

    const { subEmail } = req.body ?? {};
    if (!subEmail || typeof subEmail !== "string" || !subEmail.includes("@")) {
      replyBadRequest(res, "Valid subEmail is required."); return;
    }
    const normalizedEmail = subEmail.toLowerCase().trim();

    const projectRef = db.doc(`${COLLECTIONS.projects(companyId)}/${projectId}`);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists || projectSnap.data()?.companyId !== companyId) {
      replyNotFound(res, "Project not found."); return;
    }
    const projectData = projectSnap.data()!;

    const companySnap = await db.doc(`${COLLECTIONS.companies}/${companyId}`).get();
    const gcCompanyName = (companySnap.data()?.name as string) ?? "A general contractor";

    if (!companySnap.data()?.companyType) {
      await db.doc(`${COLLECTIONS.companies}/${companyId}`).update({ companyType: "GC", updatedAt: FieldValue.serverTimestamp() });
    }

    const connectionsCol = COLLECTIONS.projectConnections(companyId, projectId);
    const connRef = db.collection(connectionsCol).doc();
    const token = createInviteToken({
      connectionId: connRef.id,
      gcCompanyId: companyId,
      gcProjectId: projectId,
      subEmail: normalizedEmail,
    });

    const now = FieldValue.serverTimestamp();
    await connRef.set({
      id: connRef.id,
      gcCompanyId: companyId,
      gcProjectId: projectId,
      subEmail: normalizedEmail,
      subCompanyId: null,
      status: "PENDING",
      token,
      invitedAt: now,
      acceptedAt: null,
    });

    const appUrl = process.env.APP_URL ?? "http://localhost:5173";
    const acceptUrl = `${appUrl}/invite/accept?token=${token}`;
    try {
      const { error } = await getResend().emails.send({
        from: FROM,
        to: normalizedEmail,
        subject: `${gcCompanyName} invited you to collaborate on ${projectData.name}`,
        html: buildInviteEmailHtml({ gcCompanyName, projectName: projectData.name as string, acceptUrl }),
      });
      if (error) logger.warn("inviteSubApi: Resend error", { error: error.message });
    } catch (err) {
      logger.warn("inviteSubApi: email send failed", { err });
    }

    logger.info("inviteSubApi: connection created", { companyId, projectId, connectionId: connRef.id, subEmail: normalizedEmail });
    res.json({ connectionId: connRef.id });
  });
});

// ─── inviteAcceptApi ──────────────────────────────────────────────────────────

export const inviteAcceptApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method === "GET") {
      const token = req.query.token as string;
      if (!token) { replyBadRequest(res, "Token required."); return; }

      const payload = verifyInviteToken(token);
      if (!payload) { res.status(401).json({ error: "Invitation link expired or invalid." }); return; }

      const [projectSnap, gcCompanySnap, connSnap] = await Promise.all([
        db.doc(`${COLLECTIONS.projects(payload.gcCompanyId)}/${payload.gcProjectId}`).get(),
        db.doc(`${COLLECTIONS.companies}/${payload.gcCompanyId}`).get(),
        db.doc(`${COLLECTIONS.projectConnections(payload.gcCompanyId, payload.gcProjectId)}/${payload.connectionId}`).get(),
      ]);

      if (!connSnap.exists || connSnap.data()?.status !== "PENDING") {
        res.status(410).json({ error: "This invitation has already been used or is no longer valid." }); return;
      }

      res.json({
        gcCompanyName: (gcCompanySnap.data()?.name as string) ?? "",
        gcProjectName: (projectSnap.data()?.name as string) ?? "",
        subEmail: payload.subEmail,
      });
      return;
    }

    if (req.method === "POST") {
      let companyId: string;
      try {
        const auth = await verifyCompanyMember(req);
        companyId = auth.companyId;
      } catch {
        replyUnauthorized(res); return;
      }

      const { token } = req.body ?? {};
      if (!token || typeof token !== "string") { replyBadRequest(res, "Token required."); return; }

      const payload = verifyInviteToken(token);
      if (!payload) { res.status(401).json({ error: "Invitation link expired or invalid." }); return; }

      const connRef = db.doc(`${COLLECTIONS.projectConnections(payload.gcCompanyId, payload.gcProjectId)}/${payload.connectionId}`);
      const connSnap = await connRef.get();

      if (!connSnap.exists || connSnap.data()?.status !== "PENDING") {
        res.status(410).json({ error: "This invitation has already been used or is no longer valid." }); return;
      }

      const now = FieldValue.serverTimestamp();

      // Write canonical connection doc that Firestore rules can look up by ID.
      // Rules check for companies/{gcCompanyId}/projectConnections/{projectId}_{subCompanyId}.
      const canonicalId = `${payload.gcProjectId}_${companyId}`;
      const canonicalRef = db.doc(`${COLLECTIONS.projectConnections(payload.gcCompanyId)}/${canonicalId}`);

      // Batch-assign all isOurTask=true tasks in this project to the sub company.
      const tasksSnap = await db
        .collection(`${COLLECTIONS.projects(payload.gcCompanyId)}/${payload.gcProjectId}/tasks`)
        .where("isOurTask", "==", true)
        .get();

      const batch = db.batch();
      batch.update(connRef, { subCompanyId: companyId, status: "ACTIVE", acceptedAt: now });
      batch.update(db.doc(`${COLLECTIONS.companies}/${companyId}`), { companyType: "SUB", updatedAt: now });
      batch.set(canonicalRef, {
        id: canonicalId,
        gcCompanyId: payload.gcCompanyId,
        gcProjectId: payload.gcProjectId,
        subCompanyId: companyId,
        status: "ACTIVE",
        acceptedAt: now,
      });
      for (const taskDoc of tasksSnap.docs) {
        batch.update(taskDoc.ref, { assignedSubCompanyId: companyId, updatedAt: now });
      }
      await batch.commit();

      logger.info("inviteAcceptApi: connection activated", {
        connectionId: payload.connectionId,
        gcCompanyId: payload.gcCompanyId,
        subCompanyId: companyId,
        tasksAssigned: tasksSnap.size,
      });

      res.json({ gcProjectId: payload.gcProjectId, gcCompanyId: payload.gcCompanyId });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  });
});
