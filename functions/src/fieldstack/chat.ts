/**
 * Chat Cloud Function — AI Foreman powered by Claude (stub).
 *
 * In production this would:
 * 1. Accept a message + history
 * 2. Build a system prompt with company context
 * 3. Call Claude with tool definitions (list_projects, get_alerts, etc.)
 * 4. Execute tool calls against Firestore
 * 5. Return the final reply
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import cors from "cors";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest } from "./middleware";
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
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

export const chatApi = functions.runWith({ secrets: ["ANTHROPIC_API_KEY"] }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    let companyId: string;
    let uid: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
      uid = auth.decoded.uid;
    } catch {
      replyUnauthorized(res); return;
    }

    // GET — load chat history
    if (req.method === "GET") {
      const snap = await db
        .collection(COLLECTIONS.chatMessages(companyId))
        .orderBy("createdAt", "asc")
        .limit(100)
        .get();

      const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json(messages); return;
    }

    // POST — send message
    if (req.method === "POST") {
      const { message, history } = req.body ?? {};
      if (!message || typeof message !== "string") {
        replyBadRequest(res, "message is required."); return;
      }

      const anthropicKey = process.env.ANTHROPIC_API_KEY;

      if (!anthropicKey) {
        // Stub response when API key not configured
        logger.info("chat called (stub — no ANTHROPIC_API_KEY)", { companyId });
        res.json({
          reply: "AI Foreman is not yet configured. Set ANTHROPIC_API_KEY in the Cloud Functions environment to enable the AI assistant.\n\nOnce configured, I can help you:\n• Check alerts and overdue tasks\n• Review order status across projects\n• Send reminders to team members\n• Draft emails to GCs\n• Scan your Gmail inbox for updates",
        });
        return;
      }

      // TODO: Implement full Claude tool-calling loop
      // 1. Build system prompt with company/project context
      // 2. Define tools: list_projects, get_alerts, get_orders, update_step, send_reminder, etc.
      // 3. Call Claude claude-sonnet-4-5 with tool_use
      // 4. Execute tool calls against Firestore
      // 5. Continue loop until no more tool calls
      // 6. Save message + reply to chatMessages collection
      // 7. Return final reply

      logger.info("chat called (stub — implement tool loop)", { companyId });
      res.json({
        reply: "Chat implementation pending. The Claude tool-calling loop needs to be implemented in functions/src/fieldstack/chat.ts",
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  });
});

export const briefingApi = functions.runWith({ secrets: ["ANTHROPIC_API_KEY"] }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    // TODO: Compute daily briefing from Firestore data
    // 1. Load all active projects
    // 2. Find overdue task steps
    // 3. Find upcoming deadlines this week
    // 4. Find orders needing placement
    // 5. Find recent schedule changes

    logger.info("briefing called (stub)", { companyId });

    res.json({
      date: new Date().toISOString().split("T")[0],
      activeProjects: 0,
      overdue: [],
      upcoming: [],
      recentChanges: [],
      ordersNeeded: [],
      message: "Briefing stub — implement in functions/src/fieldstack/chat.ts",
    });
  });
});
