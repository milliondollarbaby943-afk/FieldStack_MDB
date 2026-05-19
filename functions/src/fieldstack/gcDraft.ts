/**
 * GC Email Draft Cloud Function — Claude drafts emails to the GC.
 * Types: schedule_change, delay_notice, delivery_confirmation
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import cors from "cors";
import { verifyCompanyMember, replyUnauthorized, replyBadRequest, replyNotFound } from "./middleware";
import { COLLECTIONS } from "./types";
import { createMessage } from "./anthropic";
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

export const gcDraftApi = functions.runWith({ secrets: ["ANTHROPIC_API_KEY"] }).https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const { projectId, type } = req.body ?? {};
    if (!projectId || !type) { replyBadRequest(res, "projectId and type are required."); return; }

    const validTypes = ["schedule_change", "delay_notice", "delivery_confirmation"];
    if (!validTypes.includes(type)) {
      replyBadRequest(res, `type must be one of: ${validTypes.join(", ")}`); return;
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      res.json({
        draft: "AI email drafting requires ANTHROPIC_API_KEY to be configured.",
        subject: "",
        to: "",
        toName: "",
      });
      return;
    }

    const projectRef = db.doc(`${COLLECTIONS.projects(companyId)}/${projectId}`);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists || projectSnap.data()?.companyId !== companyId) {
      replyNotFound(res, "Project not found."); return;
    }

    const project = projectSnap.data()!;

    let prompt = "";

    if (type === "schedule_change") {
      // Get recent schedule changes
      const changesSnap = await db
        .collection(`${COLLECTIONS.projects(companyId)}/${projectId}/scheduleChanges`)
        .orderBy("detectedAt", "desc")
        .limit(10)
        .get();

      const changes = changesSnap.docs.map((d) => d.data());
      if (changes.length === 0) {
        res.json({ draft: "No schedule changes detected to reference.", subject: "", to: "", toName: "" });
        return;
      }

      const changeText = changes.map((c) => {
        const prev = c.previousDate?.toDate ? c.previousDate.toDate().toLocaleDateString() : "?";
        const next = c.newDate?.toDate ? c.newDate.toDate().toLocaleDateString() : "?";
        return `${c.taskName} (${c.building || ""}): ${prev} → ${next} (${c.shiftDays > 0 ? "+" : ""}${c.shiftDays}d)`;
      }).join("\n");

      prompt = `Draft a professional but concise email from a cabinet/countertop subcontractor to the general contractor about schedule changes detected in the latest lookahead.

PROJECT: ${project.name}
GC: ${project.gcName}
GC CONTACT: ${project.gcContact || "Superintendent"}

SCHEDULE CHANGES DETECTED:
${changeText}

The email should:
1. Acknowledge receipt of the updated schedule
2. Confirm awareness of the specific date changes
3. Note any impact on our material ordering or crew scheduling
4. Request confirmation that the new dates are correct
5. Keep it under 150 words, professional but not stiff

Return ONLY the email body (no subject line, no "Dear X" — just the content). Use a natural contractor tone.`;
    } else if (type === "delay_notice") {
      prompt = `Draft a professional email from a cabinet/countertop subcontractor notifying the GC of a potential delay.

PROJECT: ${project.name}
GC: ${project.gcName}
GC CONTACT: ${project.gcContact || "Superintendent"}

The email should explain that materials are delayed and provide a revised timeline. Keep it under 100 words, professional but direct. Return ONLY the email body.`;
    } else {
      prompt = `Draft a brief delivery confirmation email from a cabinet/countertop subcontractor confirming material delivery to the jobsite.

PROJECT: ${project.name} at ${project.address}
GC: ${project.gcName}

Keep it under 50 words. Return ONLY the email body.`;
    }

    const message = await createMessage({
      companyId,
      action: "draft_gc_email",
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const draft = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

    const subjectMap: Record<string, string> = {
      schedule_change: `Re: ${project.name} — Schedule Update Acknowledgment`,
      delay_notice: `${project.name} — Material Delay Notice`,
      delivery_confirmation: `${project.name} — Delivery Confirmation`,
    };

    res.json({
      draft,
      subject: subjectMap[type] ?? project.name,
      to: project.gcEmail ?? "",
      toName: project.gcContact ?? project.gcName,
    });
  });
});
