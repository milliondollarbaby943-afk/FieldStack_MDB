/**
 * FieldStack Firestore collection paths and type helpers.
 *
 * Multi-tenant structure:
 *   companies/{companyId}
 *   companies/{companyId}/members/{uid}          ← via companyMembers flat collection
 *   companies/{companyId}/projectConnections/{connectionId}
 *   companies/{companyId}/projects/{projectId}
 *   companies/{companyId}/projects/{projectId}/tasks/{taskId}
 *   companies/{companyId}/projects/{projectId}/orderItems/{itemId}
 *   companies/{companyId}/projects/{projectId}/scheduleChanges/{changeId}
 *   companies/{companyId}/projects/{projectId}/taskSteps/{stepId}
 *   companies/{companyId}/projects/{projectId}/feedEntries/{entryId}
 *   companies/{companyId}/projects/{projectId}/pendingChanges/{changeId}
 *   companies/{companyId}/teamMembers/{memberId}
 *   companies/{companyId}/leadTimeSettings/{settingId}
 *   companies/{companyId}/chatMessages/{messageId}
 *   companies/{companyId}/gmailConnection (single doc)
 *   companyMembers/{companyId}_{uid}             ← flat for querying by uid
 */

export const COLLECTIONS = {
  companies: "companies",
  companyMembers: "companyMembers",
  projectConnections: (companyId: string, _projectId?: string) => `companies/${companyId}/projectConnections`,
  projects: (companyId: string) => `companies/${companyId}/projects`,
  tasks: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/tasks`,
  orderItems: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/orderItems`,
  scheduleChanges: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/scheduleChanges`,
  taskSteps: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/taskSteps`,
  feedEntries: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/feedEntries`,
  teamMembers: (companyId: string) => `companies/${companyId}/teamMembers`,
  leadTimeSettings: (companyId: string) => `companies/${companyId}/leadTimeSettings`,
  chatMessages: (companyId: string) => `companies/${companyId}/chatMessages`,
  gmailConnection: (companyId: string) => `companies/${companyId}/gmailConnection`,
  pendingChanges: (companyId: string, projectId: string) => `companies/${companyId}/projects/${projectId}/pendingChanges`,
} as const;

export type ProjectStatus = "ACTIVE" | "ON_HOLD" | "COMPLETE";
export type CompanyType = "GC" | "SUB";
export type ProjectConnectionStatus = "pending" | "active";
export type CanEditBy = "GC" | "SUB" | "BOTH";
export type OrderStatus = "NOT_ORDERED" | "ORDERED" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";
export type ItemType = "CABINETS_STANDARD" | "CABINETS_CUSTOM" | "COUNTERTOPS" | "HARDWARE" | "TRADE_MATERIALS";
export type TaskCategory = "CABINET_DELIVERY" | "CABINET_INSTALL" | "COUNTERTOP_SET" | "OTHER";
export type StepType = "SHOP_DRAWINGS" | "SUBMISSIONS" | "ORDER_MATERIALS" | "CONFIRM_DELIVERY" | "INSTALL" | "PUNCH_LIST";
export type StepStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED";
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "CLOSED";
export type TeamRole = "OWNER" | "SUPERVISOR" | "PURCHASING" | "INSTALLER" | "DRAFTING";
export type UserRole = "ADMIN" | "MEMBER" | "VIEWER";

export const DEFAULT_LEAD_TIMES: Array<{ itemType: ItemType; label: string; leadTimeWeeks: number }> = [
  { itemType: "CABINETS_STANDARD", label: "Standard Stock", leadTimeWeeks: 8 },
  { itemType: "CABINETS_CUSTOM", label: "Custom/Semi-Custom", leadTimeWeeks: 16 },
  { itemType: "COUNTERTOPS", label: "Fabricated", leadTimeWeeks: 3 },
  { itemType: "HARDWARE", label: "Standard", leadTimeWeeks: 4 },
  { itemType: "TRADE_MATERIALS", label: "Standard", leadTimeWeeks: 4 },
];
