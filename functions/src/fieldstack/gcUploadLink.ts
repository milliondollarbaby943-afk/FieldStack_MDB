/**
 * GC Upload Link Cloud Function — token-based schedule upload for GCs.
 * No Firebase auth required — the JWT token IS the auth.
 *
 * Used in weekly emails so GCs can drop a schedule file without logging in.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
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
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
});

// ─── Token helpers ────────────────────────────────────────────────────────────

const TOKEN_EXPIRY_DAYS = 7;

interface GcUploadPayload {
  projectId: string;
  gcCompanyId: string;
  exp: number; // unix timestamp
}

function getSecret(): string {
  return process.env.MAGIC_LINK_SECRET ?? process.env.NEXTAUTH_SECRET ?? "dev-magic-secret";
}

export function createGcUploadToken(projectId: string, gcCompanyId: string): string {
  const full: GcUploadPayload = {
    projectId,
    gcCompanyId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 86400,
  };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function verifyGcUploadToken(token: string): GcUploadPayload | null {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expected = crypto
      .createHmac("sha256", getSecret())
      .update(data)
      .digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as GcUploadPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Cloud Function ───────────────────────────────────────────────────────────

export const gcUploadLinkApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    // GET — verify token and return project info
    if (req.method === "GET") {
      const token = req.query.token as string;
      if (!token) { res.status(400).json({ error: "Token required." }); return; }

      const payload = verifyGcUploadToken(token);
      if (!payload) { res.status(401).json({ error: "Link expired or invalid." }); return; }

      const projectSnap = await db
        .doc(`${COLLECTIONS.projects(payload.gcCompanyId)}/${payload.projectId}`)
        .get();

      if (!projectSnap.exists) {
        res.status(404).json({ error: "Project not found." }); return;
      }

      const projectName = projectSnap.data()?.name ?? "Unknown Project";

      logger.info("gcUploadLinkApi: token verified", {
        projectId: payload.projectId,
        gcCompanyId: payload.gcCompanyId,
      });

      res.json({
        projectId: payload.projectId,
        gcCompanyId: payload.gcCompanyId,
        projectName,
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  });
});
