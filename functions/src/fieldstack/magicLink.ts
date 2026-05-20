/**
 * Magic Link Cloud Function — one-click task completion from email links.
 * No auth required — the JWT token IS the auth.
 *
 * Used in weekly digest emails and escalation emails so team members can
 * mark steps complete without logging into the app.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import cors from "cors";
import * as crypto from "crypto";
import { COLLECTIONS } from "./types";
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
  allowedHeaders: ["Content-Type"],
  credentials: true,
});

// ─── Token helpers ────────────────────────────────────────────────────────────

const TOKEN_EXPIRY_DAYS = 7;

interface MagicLinkPayload {
  stepId: string;
  action: "complete" | "block" | "note";
  ownerCompanyId: string;
  exp: number; // unix timestamp
}

function getSecret(): string {
  return process.env.MAGIC_LINK_SECRET ?? process.env.NEXTAUTH_SECRET ?? "dev-magic-secret";
}

export function createMagicToken(payload: Omit<MagicLinkPayload, "exp">): string {
  const full: MagicLinkPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 86400,
  };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function verifyMagicToken(token: string): MagicLinkPayload | null {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = crypto
      .createHmac("sha256", getSecret())
      .update(data)
      .digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as MagicLinkPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildMagicUrl(token: string): string {
  const base = process.env.APP_URL ?? "http://localhost:5173";
  return `${base}/tasks/action?token=${token}`;
}

// ─── Cloud Function ───────────────────────────────────────────────────────────

export const magicLinkApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    // GET — verify token and return step info
    if (req.method === "GET") {
      const token = req.query.token as string;
      if (!token) { res.status(400).json({ error: "Token required." }); return; }

      const payload = verifyMagicToken(token);
      if (!payload) { res.status(401).json({ error: "Link expired or invalid." }); return; }

      const stepSnap = await db
        .collectionGroup("taskSteps")
        .where("id", "==", payload.stepId)
        .where("companyId", "==", payload.ownerCompanyId)
        .limit(1)
        .get();

      if (stepSnap.empty) { res.status(404).json({ error: "Task not found." }); return; }

      const step = stepSnap.docs[0].data();
      if (step.status === "COMPLETE") {
        res.status(410).json({ error: "This task is already complete." }); return;
      }

      // Get project name
      const projectSnap = await db
        .doc(`companies/${payload.ownerCompanyId}/projects/${step.projectId}`)
        .get();
      const projectName = projectSnap.data()?.name ?? "Unknown Project";

      // Get assignee name
      let assignedToName: string | null = null;
      if (step.assignedToId) {
        const memberSnap = await db
          .doc(`companies/${payload.ownerCompanyId}/teamMembers/${step.assignedToId}`)
          .get();
        assignedToName = memberSnap.data()?.name ?? null;
      }

      res.json({
        stepType: step.stepType,
        building: step.building,
        floor: step.floor,
        dueDate: step.dueDate,
        projectName,
        assignedTo: assignedToName,
        status: step.status,
        notes: step.notes,
      });
      return;
    }

    // POST — apply action
    if (req.method === "POST") {
      const { token, action, note } = req.body ?? {};
      if (!token) { res.status(400).json({ error: "Token required." }); return; }

      const payload = verifyMagicToken(token);
      if (!payload) { res.status(401).json({ error: "Link expired or invalid." }); return; }

      const stepSnap = await db
        .collectionGroup("taskSteps")
        .where("id", "==", payload.stepId)
        .where("companyId", "==", payload.ownerCompanyId)
        .limit(1)
        .get();

      if (stepSnap.empty) { res.status(404).json({ error: "Task not found." }); return; }

      const stepRef = stepSnap.docs[0].ref;
      const stepData = stepSnap.docs[0].data();

      if (stepData.status === "COMPLETE") {
        res.status(410).json({ error: "Already complete." }); return;
      }

      const updates: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (action === "complete") {
        updates.status = "COMPLETE";
        updates.completedAt = FieldValue.serverTimestamp();
      } else if (action === "block") {
        updates.status = "BLOCKED";
      }

      if (note) {
        updates.notes = stepData.notes ? `${stepData.notes}\n---\n${note}` : note;
      }

      await stepRef.update(updates);
      logger.info("magic link action applied", { stepId: payload.stepId, action });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  });
});
