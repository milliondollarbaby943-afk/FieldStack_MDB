// ─── FieldStack Domain Types ──────────────────────────────────────────────────
// Mirrors the old Prisma schema, adapted for Firestore document model.

import { Timestamp } from "firebase/firestore";

// ─── Enums ────────────────────────────────────────────────────────────────────

export type ProjectStatus = "ACTIVE" | "ON_HOLD" | "COMPLETE";
export type CompanyType = "GC" | "SUB";
export type ProjectConnectionStatus = "pending" | "active";
export type CanEditBy = "GC" | "SUB" | "BOTH";
export type GcPlatform = "PROCORE" | "BUILDERTREND" | "OTHER";
export type TaskCategory = "CABINET_DELIVERY" | "CABINET_INSTALL" | "COUNTERTOP_SET" | "OTHER";
export type ItemType = "CABINETS_STANDARD" | "CABINETS_CUSTOM" | "COUNTERTOPS" | "HARDWARE";
export type OrderStatus = "NOT_ORDERED" | "ORDERED" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
export type TeamRole = "OWNER" | "SUPERVISOR" | "PURCHASING" | "INSTALLER" | "DRAFTING";
export type StepType = "SHOP_DRAWINGS" | "SUBMISSIONS" | "ORDER_MATERIALS" | "CONFIRM_DELIVERY" | "INSTALL" | "PUNCH_LIST";
export type StepStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED";
export type PendingChangeStatus = "PENDING" | "APPROVED" | "REJECTED" | "CONFLICT";
export type StepTrack = "CONTRACT" | "SCHEDULE";
export type EscalationLevel = "REMINDER" | "OVERDUE" | "CRITICAL";
export type CompanyPlan = "FREE" | "PRO" | "ENTERPRISE";
export type UserRole = "ADMIN" | "MEMBER" | "VIEWER";
export type AlertLevel = "CRITICAL" | "WARNING" | "INFO" | "ON_TRACK" | "VERIFY";
export type FeedType =
  | "SCHEDULE_UPDATE"
  | "DELIVERY_CONFIRMATION"
  | "CHANGE_ORDER"
  | "RFI"
  | "MEETING_NOTICE"
  | "GENERAL_COMMUNICATION"
  | "PAYMENT"
  | "ISSUE_REPORT";

// ─── Company ──────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  name: string;
  slug: string;
  plan: CompanyPlan;
  companyType: CompanyType;
  stripeCustomerId?: string | null;
  stripeSubId?: string | null;
  trialEndsAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── ProjectConnection (companies/{gcCompanyId}/projectConnections/{id}) ─────
// Links a GC project to a subcontractor company.

export interface ProjectConnection {
  id: string;
  gcCompanyId: string;
  gcProjectId: string;
  subCompanyId: string;
  status: ProjectConnectionStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── CompanyMember (users/{uid}/companyMemberships/{companyId}) ───────────────

export interface CompanyMember {
  uid: string;
  companyId: string;
  role: UserRole;
  name: string;
  email: string;
  joinedAt: Timestamp;
}

// ─── Project ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  companyId: string;
  name: string;
  address: string;
  gcName: string;
  gcContact?: string | null;
  gcEmail?: string | null;
  gcPlatform?: GcPlatform | null;
  gcProjectUrl?: string | null;
  gcProjectId?: string | null;
  procoreAccessToken?: string | null;
  procoreRefreshToken?: string | null;
  procoreTokenExpiry?: Timestamp | null;
  procoreLastSync?: Timestamp | null;
  autoSyncEnabled: boolean;
  status: ProjectStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Denormalized alert counts for dashboard display
  alertCounts?: { critical: number; warning: number };
}

// ─── ScheduleUpload ───────────────────────────────────────────────────────────

export interface ScheduleUpload {
  id: string;
  projectId: string;
  companyId: string;
  uploadedAt: Timestamp;
  fileName: string;
  rawText: string;
  version: number;
  parsedAt?: Timestamp | null;
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  projectId: string;
  companyId: string;
  scheduleUploadId: string;
  taskIdOriginal?: string | null;
  taskName: string;
  building?: string | null;
  floor?: string | null;
  gcInstallDate: Timestamp;
  gcInstallDateEnd?: Timestamp | null;
  assignedResource?: string | null;
  assignedSubCompanyId?: string | null;
  category: TaskCategory;
  isOurTask: boolean;
  createdAt: Timestamp;
}

// ─── OrderItem ────────────────────────────────────────────────────────────────

export interface OrderItem {
  id: string;
  taskId: string;
  projectId: string;
  companyId: string;
  itemType: ItemType;
  leadTimeWeeks: number;
  orderByDate: Timestamp;
  orderedAt?: Timestamp | null;
  poNumber?: string | null;
  vendorName?: string | null;
  notes?: string | null;
  status: OrderStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Denormalized from task for display
  taskName?: string;
  building?: string | null;
  floor?: string | null;
  gcInstallDate?: Timestamp;
}

// ─── PendingChange ────────────────────────────────────────────────────────────

export interface PendingChange {
  id: string;
  projectId: string;
  companyId: string;
  taskId: string;
  requestedBy: string;
  requestedByName?: string | null;
  requestedDate: Timestamp;
  originalDate: Timestamp;
  notes?: string | null;
  status: PendingChangeStatus;
  reviewedBy?: string | null;
  reviewedAt?: Timestamp | null;
  rejectionReason?: string | null;
  taskName?: string | null;
  building?: string | null;
  floor?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── ScheduleChange ───────────────────────────────────────────────────────────

export interface ScheduleChange {
  id: string;
  projectId: string;
  companyId: string;
  taskId: string;
  detectedAt: Timestamp;
  previousDate: Timestamp;
  newDate: Timestamp;
  shiftDays: number;
  notificationsSent: boolean;
  // Denormalized
  taskName?: string;
  building?: string | null;
  floor?: string | null;
}

// ─── TeamMember ───────────────────────────────────────────────────────────────

export interface TeamMember {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: TeamRole;
  notifyOnCritical: boolean;
  notifyOnOrderReminder: boolean;
  notifyOnScheduleChange: boolean;
  createdAt: Timestamp;
}

// ─── TaskStep ─────────────────────────────────────────────────────────────────

export interface TaskStep {
  id: string;
  projectId: string;
  companyId: string;
  taskId?: string | null;
  building?: string | null;
  floor?: string | null;
  stepType: StepType;
  canEditBy: CanEditBy;
  assignedToId?: string | null;
  assignedToName?: string | null;
  dueDate?: Timestamp | null;
  completedAt?: Timestamp | null;
  status: StepStatus;
  notes?: string | null;
  canEditBy?: "GC" | "SUB" | "BOTH" | null;
  track: StepTrack;
  dependsOnId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── EscalationLog ────────────────────────────────────────────────────────────

export interface EscalationLog {
  id: string;
  taskStepId: string;
  companyId: string;
  level: EscalationLevel;
  sentAt: Timestamp;
  sentTo: string;
}

// ─── LeadTimeSetting ─────────────────────────────────────────────────────────

export interface LeadTimeSetting {
  id: string;
  companyId: string;
  itemType: ItemType;
  leadTimeWeeks: number;
  isDefault: boolean;
  projectId?: string | null;
  label?: string | null;
}

// ─── ChatMessage ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  companyId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: string | null;
  createdAt: Timestamp;
}

// ─── GmailConnection ─────────────────────────────────────────────────────────

export interface GmailConnection {
  id: string;
  companyId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Timestamp;
  lastSyncAt?: Timestamp | null;
  createdAt: Timestamp;
}

// ─── FeedEntry ────────────────────────────────────────────────────────────────

export interface FeedEntry {
  id: string;
  companyId: string;
  projectId?: string | null;
  type: FeedType;
  title: string;
  summary: string;
  sender?: string | null;
  senderEmail?: string | null;
  emailId?: string | null;
  emailDate?: Timestamp | null;
  actionNeeded: boolean;
  actionType?: string | null;
  confidence?: number | null;
  rawSnippet?: string | null;
  processedAt: Timestamp;
  // Denormalized
  projectName?: string | null;
}

// ─── Alert (computed, not stored) ────────────────────────────────────────────

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  projectId: string;
  projectName: string;
  taskId: string;
  orderItemId?: string;
  installDate: Timestamp;
  orderByDate: Timestamp;
  orderStatus: OrderStatus;
  building?: string | null;
  floor?: string | null;
  itemType: ItemType;
  daysUntilOrderBy: number;
}

// ─── Briefing (computed) ─────────────────────────────────────────────────────

export interface BriefingItem {
  project: string;
  step?: string;
  building?: string;
  dueDate?: string;
  daysOverdue?: number;
  assignedTo?: string;
  shiftDays?: number;
  task?: string;
  item?: string;
  orderByDate?: string;
}

export interface Briefing {
  date: string;
  activeProjects: number;
  overdue: BriefingItem[];
  upcoming: BriefingItem[];
  recentChanges: BriefingItem[];
  ordersNeeded: BriefingItem[];
}

// ─── Label helpers ────────────────────────────────────────────────────────────

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  CABINETS_STANDARD: "Cabinets (standard)",
  CABINETS_CUSTOM: "Cabinets (custom)",
  COUNTERTOPS: "Countertops",
  HARDWARE: "Hardware",
};

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  CABINET_DELIVERY: "Cabinet Delivery",
  CABINET_INSTALL: "Cabinet Install",
  COUNTERTOP_SET: "Countertop Set",
  OTHER: "Other",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NOT_ORDERED: "Not Ordered",
  ORDERED: "Ordered",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const STEP_TYPE_LABELS: Record<StepType, string> = {
  SHOP_DRAWINGS: "Shop Drawings",
  SUBMISSIONS: "Submissions",
  ORDER_MATERIALS: "Order Materials",
  CONFIRM_DELIVERY: "Confirm Delivery",
  INSTALL: "Install",
  PUNCH_LIST: "Punch List",
};

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  OWNER: "Owner",
  SUPERVISOR: "Supervisor",
  PURCHASING: "Purchasing",
  INSTALLER: "Installer",
  DRAFTING: "Drafting",
};

export const FEED_TYPE_LABELS: Record<FeedType, string> = {
  SCHEDULE_UPDATE: "Schedule Update",
  DELIVERY_CONFIRMATION: "Delivery Confirmation",
  CHANGE_ORDER: "Change Order",
  RFI: "RFI",
  MEETING_NOTICE: "Meeting Notice",
  GENERAL_COMMUNICATION: "General Communication",
  PAYMENT: "Payment",
  ISSUE_REPORT: "Issue Report",
};

export const DEFAULT_LEAD_TIMES: Array<{ itemType: ItemType; label: string; leadTimeWeeks: number }> = [
  { itemType: "CABINETS_STANDARD", label: "Standard Stock", leadTimeWeeks: 8 },
  { itemType: "CABINETS_CUSTOM", label: "Custom/Semi-Custom", leadTimeWeeks: 16 },
  { itemType: "COUNTERTOPS", label: "Fabricated", leadTimeWeeks: 3 },
  { itemType: "HARDWARE", label: "Standard", leadTimeWeeks: 4 },
];
