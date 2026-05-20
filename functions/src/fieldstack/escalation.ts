/**
 * Escalation engine — three-tier progressive alerts.
 * REMINDER (3 days before due) → OVERDUE (past due) → CRITICAL (2+ days overdue)
 *
 * Also handles weekly digest email generation.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import cors from "cors";
import { Resend } from "resend";
import { verifyCompanyMember, replyUnauthorized } from "./middleware";
import { COLLECTIONS } from "./types";
import { createMagicToken, buildMagicUrl } from "./magicLink";
import { buildEscalationEmailHtml, buildDigestEmailHtml, type DigestData } from "./emailTemplates";
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

const STEP_LABELS: Record<string, string> = {
  SHOP_DRAWINGS: "Shop Drawings",
  SUBMISSIONS: "Submissions",
  ORDER_MATERIALS: "Order Materials",
  CONFIRM_DELIVERY: "Confirm Delivery",
  INSTALL: "Install",
  PUNCH_LIST: "Punch List",
};

// ─── Escalation cron (daily) ──────────────────────────────────────────────────

export const escalationCron = functions.pubsub
  .schedule("15 7 * * *") // 7:15am UTC daily
  .timeZone("UTC")
  .onRun(async (_context) => {
    logger.info("escalationCron triggered");
    await runEscalationForAllCompanies();
  });

// ─── Manual trigger endpoint ──────────────────────────────────────────────────

export const escalationApi = functions.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    let companyId: string;
    try {
      const auth = await verifyCompanyMember(req);
      companyId = auth.companyId;
    } catch {
      replyUnauthorized(res); return;
    }

    const companySnap = await db.collection("companies").doc(companyId).get();
    const isSub = companySnap.data()?.companyType === "SUB";
    const result = isSub
      ? await runSubEscalationForSub(companyId)
      : await runEscalationForCompany(companyId);
    res.json(result);
  });
});

// ─── Weekly digest cron ───────────────────────────────────────────────────────

export const digestCron = functions.pubsub
  .schedule("0 7 * * 1") // 7am UTC every Monday
  .timeZone("UTC")
  .onRun(async (_context) => {
    logger.info("digestCron triggered");
    await sendWeeklyDigestForAllCompanies();
  });

// ─── Core escalation logic ────────────────────────────────────────────────────

async function runEscalationForAllCompanies(): Promise<void> {
  const companiesSnap = await db.collection("companies").get();
  for (const companyDoc of companiesSnap.docs) {
    try {
      const company = companyDoc.data();
      if (company.companyType === "SUB") {
        await runSubEscalationForSub(companyDoc.id);
      } else {
        await runEscalationForCompany(companyDoc.id);
      }
    } catch (err) {
      logger.error("escalation failed for company", { companyId: companyDoc.id, error: String(err) });
    }
  }
}

async function runEscalationForCompany(companyId: string): Promise<{
  reminders: number;
  overdue: number;
  critical: number;
}> {
  const now = new Date();
  let reminders = 0;
  let overdue = 0;
  let critical = 0;

  // Get all non-complete steps with due dates for this company
  const stepsSnap = await db
    .collectionGroup("taskSteps")
    .where("companyId", "==", companyId)
    .where("status", "!=", "COMPLETE")
    .get();

  // Get team members for escalation targets
  const teamSnap = await db.collection(COLLECTIONS.teamMembers(companyId)).get();
  const teamMembers = teamSnap.docs.map((d) => d.data());
  const owner = teamMembers.find((m) => m.role === "OWNER");
  const supervisors = teamMembers.filter((m) => m.role === "SUPERVISOR");

  for (const stepDoc of stepsSnap.docs) {
    const step = stepDoc.data();
    if (!step.dueDate || !step.assignedToId) continue;

    const dueDate = step.dueDate.toDate ? step.dueDate.toDate() : new Date(step.dueDate);
    const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const history = await getEscalationHistory(step.id, "GC", now);
    if (history.sentToday) continue;

    // Get assignee
    const assignee = teamMembers.find((m) => m.id === step.assignedToId);
    if (!assignee) continue;

    const stepLabel = STEP_LABELS[step.stepType] ?? step.stepType;
    const location = [step.building, step.floor].filter(Boolean).join(" / ") || "General";

    const magicToken = createMagicToken({ stepId: step.id, action: "complete", companyId });
    const magicUrl = buildMagicUrl(magicToken);

    const emailParams = {
      level: "",
      stepLabel,
      location,
      projectName: step.projectName ?? "Project",
      assigneeName: assignee.name,
      daysOverdue: Math.abs(daysUntilDue),
      dueInDays: daysUntilDue,
      projectId: step.projectId,
      magicUrl,
    };

    // CRITICAL: 2+ days overdue → escalate to owner
    if (daysUntilDue <= -2 && history.lastLevel !== "CRITICAL") {
      if (owner) {
        emailParams.level = "CRITICAL";
        await sendEscalationEmail({ ...emailParams, to: owner.email });
        await logEscalation(companyId, step.id, "CRITICAL", owner.email, "GC");
        critical++;
      }
    }
    // OVERDUE: past due → escalate to supervisor + assignee
    else if (daysUntilDue < 0 && history.lastLevel !== "OVERDUE") {
      emailParams.level = "OVERDUE";
      const recipients = [assignee.email, ...supervisors.map((s) => s.email)];
      for (const email of [...new Set(recipients)]) {
        await sendEscalationEmail({ ...emailParams, to: email });
      }
      await logEscalation(companyId, step.id, "OVERDUE", assignee.email, "GC");
      overdue++;
    }
    // REMINDER: due within 3 days → remind assignee
    else if (daysUntilDue <= 3 && daysUntilDue >= 0 && !history.lastLevel) {
      emailParams.level = "REMINDER";
      await sendEscalationEmail({ ...emailParams, to: assignee.email });
      await logEscalation(companyId, step.id, "REMINDER", assignee.email, "GC");
      reminders++;
    }
  }

  logger.info("escalation complete", { companyId, reminders, overdue, critical });
  return { reminders, overdue, critical };
}

async function sendEscalationEmail(params: {
  to: string;
  level: string;
  stepLabel: string;
  location: string;
  projectName: string;
  assigneeName: string;
  daysOverdue: number;
  dueInDays?: number;
  projectId: string;
  magicUrl: string;
}): Promise<void> {
  const resend = getResend();
  const { subject, html } = buildEscalationEmailHtml(params);

  if (!resend) {
    logger.info(`[ESCALATION SKIPPED] ${params.level} → ${params.to}: ${subject}`);
    return;
  }

  try {
    await resend.emails.send({ from: FROM, to: params.to, subject, html });
  } catch (err) {
    logger.error("escalation email failed", { to: params.to, error: String(err) });
  }
}

async function getEscalationHistory(
  taskStepId: string,
  recipientType: "GC" | "SUB",
  now: Date
): Promise<{ sentToday: boolean; lastLevel?: string }> {
  const snap = await db
    .collection("escalationLogs")
    .where("taskStepId", "==", taskStepId)
    .orderBy("sentAt", "desc")
    .limit(10)
    .get();

  const relevant = snap.docs
    .map((d) => d.data())
    .filter((log) => (log.recipientType ?? "GC") === recipientType);

  if (relevant.length === 0) return { sentToday: false };

  const last = relevant[0];
  const sentToday = last.sentAt.toDate().toDateString() === now.toDateString();
  return { sentToday, lastLevel: last.level as string };
}

async function logEscalation(
  companyId: string,
  taskStepId: string,
  level: string,
  sentTo: string,
  recipientType: "GC" | "SUB" = "GC"
): Promise<void> {
  const ref = db.collection("escalationLogs").doc();
  await ref.set({
    id: ref.id,
    companyId,
    taskStepId,
    level,
    sentTo,
    recipientType,
    sentAt: FieldValue.serverTimestamp(),
  });
}

async function runSubEscalationForSub(subCompanyId: string): Promise<{
  reminders: number;
  overdue: number;
  critical: number;
}> {
  const now = new Date();
  let reminders = 0;
  let overdue = 0;
  let critical = 0;

  const stepsSnap = await db
    .collectionGroup("taskSteps")
    .where("assignedSubCompanyId", "==", subCompanyId)
    .where("status", "!=", "COMPLETE")
    .get();

  const teamSnap = await db.collection(COLLECTIONS.teamMembers(subCompanyId)).get();
  const teamMembers = teamSnap.docs.map((d) => d.data());
  const owner = teamMembers.find((m) => m.role === "OWNER");
  const supervisors = teamMembers.filter((m) => m.role === "SUPERVISOR");

  if (!owner && supervisors.length === 0) {
    logger.info("sub escalation skipped: no owner or supervisors", { subCompanyId });
    return { reminders: 0, overdue: 0, critical: 0 };
  }

  for (const stepDoc of stepsSnap.docs) {
    const step = stepDoc.data();
    if (!step.dueDate) continue;

    const dueDate = step.dueDate.toDate ? step.dueDate.toDate() : new Date(step.dueDate);
    const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const history = await getEscalationHistory(step.id, "SUB", now);
    if (history.sentToday) continue;

    const stepLabel = STEP_LABELS[step.stepType] ?? step.stepType;
    const location = [step.building, step.floor].filter(Boolean).join(" / ") || "General";

    // Magic link uses gcCompanyId — step.companyId is always the GC's companyId
    const magicToken = createMagicToken({ stepId: step.id, action: "complete", companyId: step.companyId });
    const magicUrl = buildMagicUrl(magicToken);

    const primaryName = owner?.name ?? supervisors[0]?.name ?? "Team";
    const emailParams = {
      level: "",
      stepLabel,
      location,
      projectName: step.projectName ?? "Project",
      assigneeName: primaryName,
      daysOverdue: Math.abs(daysUntilDue),
      dueInDays: daysUntilDue,
      projectId: step.projectId,
      magicUrl,
    };

    if (daysUntilDue <= -2 && history.lastLevel !== "CRITICAL") {
      if (owner) {
        emailParams.level = "CRITICAL";
        await sendEscalationEmail({ ...emailParams, to: owner.email });
        await logEscalation(subCompanyId, step.id, "CRITICAL", owner.email, "SUB");
        critical++;
      }
    } else if (daysUntilDue < 0 && history.lastLevel !== "OVERDUE") {
      emailParams.level = "OVERDUE";
      const recipients: string[] = [];
      if (owner) recipients.push(owner.email);
      for (const s of supervisors) recipients.push(s.email);
      for (const email of [...new Set(recipients)]) {
        await sendEscalationEmail({ ...emailParams, to: email });
      }
      const logTarget = owner?.email ?? supervisors[0].email;
      await logEscalation(subCompanyId, step.id, "OVERDUE", logTarget, "SUB");
      overdue++;
    } else if (daysUntilDue <= 3 && daysUntilDue >= 0 && !history.lastLevel) {
      emailParams.level = "REMINDER";
      const recipients: string[] = [];
      if (owner) recipients.push(owner.email);
      for (const s of supervisors) recipients.push(s.email);
      for (const email of [...new Set(recipients)]) {
        await sendEscalationEmail({ ...emailParams, to: email });
      }
      const logTarget = owner?.email ?? supervisors[0].email;
      await logEscalation(subCompanyId, step.id, "REMINDER", logTarget, "SUB");
      reminders++;
    }
  }

  logger.info("sub escalation complete", { subCompanyId, reminders, overdue, critical });
  return { reminders, overdue, critical };
}

// ─── Weekly digest ────────────────────────────────────────────────────────────

async function sendWeeklyDigestForAllCompanies(): Promise<void> {
  const companiesSnap = await db.collection("companies").get();
  for (const companyDoc of companiesSnap.docs) {
    try {
      await sendWeeklyDigestForCompany(companyDoc.id, companyDoc.data().name);
    } catch (err) {
      logger.error("digest failed for company", { companyId: companyDoc.id, error: String(err) });
    }
  }
}

async function sendWeeklyDigestForCompany(companyId: string, companyName: string): Promise<void> {
  const resend = getResend();
  const today = new Date();
  const weekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Get admin emails
  const membershipsSnap = await db
    .collection("companyMembers")
    .where("companyId", "==", companyId)
    .where("role", "==", "ADMIN")
    .get();

  const adminEmails = membershipsSnap.docs.map((d) => d.data().email as string);
  if (adminEmails.length === 0) return;

  // Get active projects
  const projectsSnap = await db
    .collection(COLLECTIONS.projects(companyId))
    .where("status", "==", "ACTIVE")
    .get();

  if (projectsSnap.empty) return;

  // Get overdue steps
  const overdueSnap = await db
    .collectionGroup("taskSteps")
    .where("companyId", "==", companyId)
    .where("status", "!=", "COMPLETE")
    .get();

  const overdueSteps = overdueSnap.docs
    .map((d) => d.data())
    .filter((s) => s.dueDate && s.dueDate.toDate() < today)
    .slice(0, 15);

  // Get upcoming steps
  const upcomingSteps = overdueSnap.docs
    .map((d) => d.data())
    .filter((s) => {
      if (!s.dueDate) return false;
      const d = s.dueDate.toDate();
      return d >= today && d <= weekFromNow;
    })
    .slice(0, 15);

  // Get recent changes
  const changesSnap = await db
    .collectionGroup("scheduleChanges")
    .where("companyId", "==", companyId)
    .get();

  const recentChanges = changesSnap.docs
    .map((d) => d.data())
    .filter((c) => c.detectedAt && c.detectedAt.toDate() >= weekAgo)
    .slice(0, 5);

  // Get team members for name lookup
  const teamSnap = await db.collection(COLLECTIONS.teamMembers(companyId)).get();
  const teamById = new Map(teamSnap.docs.map((d) => [d.id, d.data()]));

  // Build magic links for overdue steps
  const overdueWithLinks = await Promise.all(
    overdueSteps.slice(0, 10).map(async (s) => {
      const token = createMagicToken({ stepId: s.id, action: "complete", companyId });
      const assignee = s.assignedToId ? teamById.get(s.assignedToId) : null;
      const dueDate = s.dueDate?.toDate ? s.dueDate.toDate() : null;
      return {
        stepType: s.stepType as string,
        building: s.building as string | null,
        projectName: s.projectName ?? "Project",
        assignedToName: assignee?.name ?? null,
        dueDate,
        daysOverdue: dueDate ? Math.round((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0,
        magicUrl: buildMagicUrl(token),
      };
    })
  );

  const digestData: DigestData = {
    companyName,
    projects: projectsSnap.size,
    overdue: overdueWithLinks,
    upcoming: upcomingSteps.map((s) => {
      const assignee = s.assignedToId ? teamById.get(s.assignedToId) : null;
      return {
        stepType: s.stepType as string,
        building: s.building as string | null,
        projectName: s.projectName ?? "Project",
        assignedToName: assignee?.name ?? null,
        dueDate: s.dueDate?.toDate ? s.dueDate.toDate() : null,
      };
    }),
    completedCount: 0, // TODO: count completed this week
    changes: recentChanges.map((c) => ({
      taskName: c.taskName ?? "Task",
      projectName: c.projectName ?? "Project",
      shiftDays: c.shiftDays as number,
    })),
    today,
  };

  const html = buildDigestEmailHtml(digestData);
  const weekLabel = today.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const subject = `FieldStack Weekly: ${overdueSteps.length} overdue, ${upcomingSteps.length} upcoming — Week of ${weekLabel}`;

  if (!resend) {
    logger.info(`[DIGEST SKIPPED] Would send to ${adminEmails.join(", ")}: ${subject}`);
    return;
  }

  await resend.emails.send({ from: FROM, to: adminEmails, subject, html });
  logger.info("weekly digest sent", { companyId, recipients: adminEmails.length });
}
