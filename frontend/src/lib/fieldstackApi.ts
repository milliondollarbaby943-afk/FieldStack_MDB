/**
 * FieldStack API client — direct HTTP calls to Cloud Functions.
 *
 * Two modes, both handled transparently via functionsBaseUrl + apiPath():
 *
 * EMULATOR (VITE_USE_EMULATORS=true):
 *   Calls functions directly: http://127.0.0.1:5001/{project}/us-central1/{functionName}/{subPath}
 *   e.g. http://127.0.0.1:5001/fieldstack-testing/us-central1/myTasksApi
 *
 * PRODUCTION (deployed to Firebase Hosting):
 *   Uses relative /api/* paths routed through firebase.json Hosting rewrites.
 *   Same-origin — no CORS headers needed.
 *   e.g. /api/my-tasks
 *
 * The apiPath() helper returns the right URL for each environment.
 */

import { getAuthToken, ApiError } from "@/lib/api";
import { functionsBaseUrl } from "@/lib/firebase";

// ─── Route map ────────────────────────────────────────────────────────────────
// Maps function name → hosting rewrite path (used in production).
// Must stay in sync with firebase.json rewrites.

const FUNCTION_PATHS: Record<string, string> = {
  projectsApi:            "/api/projects",
  schedulesUploadApi:     "/api/schedules/upload",
  ordersApi:              "/api/orders",
  alertsSendApi:          "/api/alerts/send",
  alertsSendToMemberApi:  "/api/alerts/send-to-member",
  chatApi:                "/api/chat",
  briefingApi:            "/api/briefing",
  feedApi:                "/api/feed",
  gmailApi:               "/api/gmail",
  gmailScanApi:           "/api/gmail/scan",
  gmailCallbackApi:       "/api/gmail/callback",
  teamApi:                "/api/team",
  leadTimesApi:           "/api/settings/lead-times",
  smsBriefingApi:         "/api/sms-briefing",
  myTasksApi:             "/api/my-tasks",
  pendingChangesApi:      "/api/pending-changes",
  procoreAuthUrlApi:      "/api/procore/auth-url",
  procoreSyncApi:         "/api/procore/sync",
  procoreCallbackApi:     "/api/procore/callback",
  stepsApi:               "/api/steps",
  magicLinkApi:           "/api/magic-link",
  escalationApi:          "/api/alerts/escalate",
  gcDraftApi:             "/api/gc-draft",
  fromScheduleApi:        "/api/projects/from-schedule",
  itemsApi:               "/api/items",
  submitSupportTicket:    "/api/support",
  getAdminStats:          "/api/admin-stats",
  createCheckoutSession:  "/api/createCheckoutSession",
  createPortalSession:    "/api/createPortalSession",
  changeSubscription:     "/api/changeSubscription",
  cancelSubscription:     "/api/cancelSubscription",
  reactivateSubscription: "/api/reactivateSubscription",
  syncSubscription:       "/api/syncSubscription",
  getInvoices:            "/api/getInvoices",
  reportFrontendError:    "/api/report-error",
};

/**
 * Returns the full URL for a function call.
 * Emulator: http://127.0.0.1:5001/{project}/us-central1/{functionName}{subPath}
 * Production: /api/{route}{subPath}  (same-origin via Hosting rewrite)
 */
function apiPath(functionName: string, subPath = ""): string {
  if (functionsBaseUrl) {
    // Emulator — call function directly by name
    return `${functionsBaseUrl}/${functionName}${subPath}`;
  }
  // Production — use the Hosting rewrite path
  const base = FUNCTION_PATHS[functionName];
  if (!base) throw new Error(`[fieldstackApi] No path mapping for function: ${functionName}`);
  return `${base}${subPath}`;
}

// ─── Base helper ──────────────────────────────────────────────────────────────

async function callFunction<T>(
  functionName: string,
  subPath = "",
  options: RequestInit = {}
): Promise<T> {
  const token = await getAuthToken();
  if (!token) throw new ApiError("You must be signed in.", 401, false);

  const url = apiPath(functionName, subPath);

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const msg = typeof body?.error === "string" ? body.error : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, res.status >= 500);
  }

  return res.json();
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function apiCreateProject(data: {
  name: string;
  address: string;
  gcName: string;
  gcContact?: string;
  gcEmail?: string;
  gcPlatform?: string;
}): Promise<{ id: string }> {
  return callFunction("projectsApi", "", { method: "POST", body: JSON.stringify(data) });
}

export async function apiUpdateProject(
  id: string,
  data: Partial<{ name: string; address: string; gcName: string; gcContact: string; gcEmail: string; status: string; gcPlatform: string; autoSyncEnabled: boolean }>
): Promise<void> {
  return callFunction("projectsApi", `/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function apiDeleteProject(id: string): Promise<void> {
  return callFunction("projectsApi", `/${id}`, { method: "DELETE" });
}

// ─── Schedule Upload ──────────────────────────────────────────────────────────

export async function apiUploadSchedule(
  projectId: string,
  file: File
): Promise<{ tasksCreated: number; orderItemsCreated: number; version: number; changesDetected: number }> {
  const token = await getAuthToken();
  if (!token) throw new ApiError("You must be signed in.", 401, false);

  const fd = new FormData();
  fd.append("file", file);
  fd.append("projectId", projectId);

  const res = await fetch(apiPath("schedulesUploadApi"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body?.error ?? `Upload failed (${res.status})`, res.status, res.status >= 500);
  }

  return res.json();
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function apiUpdateOrder(
  id: string,
  data: Partial<{
    status: string;
    poNumber: string;
    vendorName: string;
    notes: string;
    orderedAt: string;
  }>
): Promise<void> {
  return callFunction("ordersApi", `/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export async function apiSendAlerts(projectId: string): Promise<{
  alerts: number;
  changes: number;
  resendConfigured: boolean;
}> {
  return callFunction("alertsSendApi", "", { method: "POST", body: JSON.stringify({ projectId }) });
}

export async function apiSendAlertToMember(params: {
  email: string;
  alert: object;
  projectId: string;
}): Promise<void> {
  return callFunction("alertsSendToMemberApi", "", { method: "POST", body: JSON.stringify(params) });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export async function apiChat(params: {
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ reply: string; requiresConfirmation?: boolean; pendingAction?: object }> {
  return callFunction("chatApi", "", { method: "POST", body: JSON.stringify(params) });
}

export async function apiGetChatHistory(): Promise<
  Array<{ role: "user" | "assistant"; content: string; id: string }>
> {
  return callFunction("chatApi");
}

// ─── Briefing ─────────────────────────────────────────────────────────────────

export async function apiGetBriefing(): Promise<{
  date: string;
  activeProjects: number;
  overdue: object[];
  upcoming: object[];
  recentChanges: object[];
  ordersNeeded: object[];
}> {
  return callFunction("briefingApi");
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

export async function apiGetFeed(projectId?: string): Promise<object[]> {
  const qs = projectId ? `?projectId=${projectId}` : "";
  return callFunction("feedApi", qs);
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

export async function apiGetGmailStatus(): Promise<{
  connected: boolean;
  email?: string;
  lastSyncAt?: string;
}> {
  return callFunction("gmailApi");
}

export async function apiScanGmail(hoursBack = 24): Promise<{
  processed: number;
  saved: number;
  skipped: number;
}> {
  return callFunction("gmailScanApi", "", { method: "POST", body: JSON.stringify({ hoursBack }) });
}

export async function apiDisconnectGmail(): Promise<void> {
  return callFunction("gmailApi", "", { method: "DELETE" });
}

// ─── Team ─────────────────────────────────────────────────────────────────────

export async function apiCreateTeamMember(data: {
  name: string;
  email: string;
  role: string;
  notifyOnCritical?: boolean;
  notifyOnOrderReminder?: boolean;
  notifyOnScheduleChange?: boolean;
}): Promise<{ id: string }> {
  return callFunction("teamApi", "", { method: "POST", body: JSON.stringify(data) });
}

export async function apiUpdateTeamMember(
  id: string,
  data: Partial<{
    name: string;
    email: string;
    role: string;
    notifyOnCritical: boolean;
    notifyOnOrderReminder: boolean;
    notifyOnScheduleChange: boolean;
  }>
): Promise<void> {
  return callFunction("teamApi", `/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function apiDeleteTeamMember(id: string): Promise<void> {
  return callFunction("teamApi", `/${id}`, { method: "DELETE" });
}

// ─── Lead Times ───────────────────────────────────────────────────────────────

export async function apiUpdateLeadTimes(
  settings: Array<{ itemType: string; leadTimeWeeks: number; projectId?: string }>
): Promise<void> {
  return callFunction("leadTimesApi", "", { method: "PATCH", body: JSON.stringify({ settings }) });
}

// ─── Procore ──────────────────────────────────────────────────────────────────

export async function apiGetProcoreAuthUrl(projectId: string): Promise<{ url: string }> {
  return callFunction("procoreAuthUrlApi", `?projectId=${projectId}`);
}

export async function apiSyncProcore(projectId: string): Promise<{
  tasksCreated: number;
  tasksUpdated: number;
}> {
  return callFunction("procoreSyncApi", "", { method: "POST", body: JSON.stringify({ projectId }) });
}

// ─── SMS Briefing ─────────────────────────────────────────────────────────────

export async function apiSendSmsBriefing(phoneNumber: string): Promise<{ sent: boolean }> {
  return callFunction("smsBriefingApi", "", { method: "POST", body: JSON.stringify({ phoneNumber }) });
}

// ─── My Tasks ─────────────────────────────────────────────────────────────────

export async function apiGetMyTasks(): Promise<object[]> {
  return callFunction("myTasksApi");
}

// ─── Pending Changes ──────────────────────────────────────────────────────────

export async function apiGetPendingChanges(projectId: string): Promise<object[]> {
  return callFunction("pendingChangesApi", `?projectId=${encodeURIComponent(projectId)}`);
}

export async function apiRequestDateChange(data: {
  projectId: string;
  taskId: string;
  requestedDate: string;
  notes?: string;
  requestedByName?: string;
}): Promise<{ id: string }> {
  return callFunction("pendingChangesApi", "", { method: "POST", body: JSON.stringify(data) });
}

export async function apiApprovePendingChange(changeId: string): Promise<void> {
  return callFunction("pendingChangesApi", `/${changeId}/approve`, { method: "PATCH" });
}

export async function apiRejectPendingChange(changeId: string, reason?: string): Promise<void> {
  return callFunction("pendingChangesApi", `/${changeId}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ reason }),
  });
}
