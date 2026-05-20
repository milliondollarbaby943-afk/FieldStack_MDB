import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail, Upload, Download, Bot } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format, differenceInDays } from "date-fns";
import { apiSendAlerts, apiSendAlertToMember, apiUpdateTask, apiBulkEditTasks, apiUploadTaskCsv } from "@/lib/fieldstackApi";
import { alertColor } from "@/lib/alerts";
import { useCompany } from "@/contexts/CompanyContext";
import type { Alert, Task, ScheduleChange, TeamMember, TaskStatus } from "@/types/fieldstack";

function fmt(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d, yyyy");
}
function fmtShort(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d");
}

interface Props {
  alerts: Alert[];
  criticalAlerts: Alert[];
  warningAlerts: Alert[];
  tasks: Task[];
  ourTasks: Task[];
  changes: ScheduleChange[];
  projectId: string;
  team: TeamMember[];
  hasTasks: boolean;
  onFilePicked: (f: File) => void;
  uploading: boolean;
}

export function OverviewTab({ alerts, criticalAlerts, warningAlerts, tasks, ourTasks, changes, projectId, team, hasTasks, onFilePicked, uploading }: Props) {
  const { company } = useCompany();
  const isGc = company?.companyType === "GC";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ alerts: number; changes: number; resendConfigured: boolean } | null>(null);

  // GCs see next install from any trade; subs see from their own tasks only
  const installPool = isGc ? tasks : ourTasks;
  const nextInstall = [...installPool].sort((a, b) => {
    const aDate = a.gcInstallDate instanceof Timestamp ? a.gcInstallDate.toMillis() : 0;
    const bDate = b.gcInstallDate instanceof Timestamp ? b.gcInstallDate.toMillis() : 0;
    return aDate - bDate;
  })[0];

  async function sendAlerts() {
    setSending(true);
    setSendResult(null);
    try {
      const data = await apiSendAlerts(projectId);
      setSendResult(data);
      toast.success("Alerts sent.");
    } catch {
      toast.error("Failed to send alerts.");
    } finally {
      setSending(false);
    }
  }

  if (!hasTasks && uploading) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-14 text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-2.5 h-2.5 rounded-full bg-primary animate-bounce"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <p className="text-sm font-medium">Reading your schedule…</p>
          <p className="text-xs text-muted-foreground mt-1">Extracting tasks and dates</p>
        </CardContent>
      </Card>
    );
  }

  if (!hasTasks && !uploading) {
    return (
      <>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.txt,.csv"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFilePicked(f); }}
        />
        <Card
          className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
          onClick={() => fileInputRef.current?.click()}
        >
          <CardContent className="py-14 text-center">
            <div className="text-4xl mb-3 opacity-40">📄</div>
            <p className="text-base font-semibold mb-2">Drop your GC schedule to get started</p>
            <p className="text-sm text-muted-foreground mb-5">or click to browse — PDF, XLSX, or plain text</p>
            <Button className="gap-2">
              <Upload className="h-4 w-4" /> Upload Schedule
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      {hasTasks && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {isGc ? (
            <MiniStat
              label="Schedule Tasks"
              value={tasks.length}
              sub={ourTasks.length > 0 ? `Cab/CT: ${ourTasks.length}` : "All trades"}
            />
          ) : (
            <MiniStat label="Cab + CT Tasks" value={ourTasks.length} sub="Cabinet + countertop" />
          )}
          <MiniStat label="Critical" value={criticalAlerts.length} color={criticalAlerts.length > 0 ? "text-red-500" : "text-emerald-500"} sub="Past order-by date" />
          <MiniStat label="Warnings" value={warningAlerts.length} color={warningAlerts.length > 0 ? "text-yellow-500" : "text-emerald-500"} sub="Due within 14 days" />
          <MiniStat label="Next Install" value={nextInstall ? fmtShort(nextInstall.gcInstallDate) : "—"} sub={nextInstall?.taskName ?? "No tasks"} />
        </div>
      )}

      {/* Alerts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Alerts & Actions</span>
          <Button size="sm" variant="outline" onClick={sendAlerts} disabled={sending} className="gap-1.5">
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {sending ? "Sending..." : "Send Alerts Now"}
          </Button>
        </div>

        {sendResult && (
          <div className={`text-xs font-mono p-3 rounded-lg mb-3 ${sendResult.resendConfigured ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" : "bg-yellow-500/10 text-yellow-600 border border-yellow-500/20"}`}>
            {!sendResult.resendConfigured && <div className="mb-1">⚠ Resend not configured — emails logged to console</div>}
            <div>Alerts: {sendResult.alerts} · Changes: {sendResult.changes}</div>
          </div>
        )}

        {alerts.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              <div className="text-2xl mb-2">✓</div>
              <div className="text-sm font-medium">All clear — no alerts for this project</div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-2">
          {alerts.map((a) => (
            <AlertCard key={a.id} alert={a} projectId={projectId} team={team} />
          ))}
        </div>
      </div>

      {/* Recent changes */}
      {changes.length > 0 && (
        <div>
          <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">Recent Schedule Changes</div>
          <div className="flex flex-col gap-2">
            {changes.slice(0, 5).map((c) => (
              <Card key={c.id}>
                <CardContent className="flex items-center justify-between gap-4 py-3 px-4">
                  <div>
                    <span className="text-sm font-medium">{c.taskName}</span>
                    {(c.building || c.floor) && (
                      <span className="text-xs text-muted-foreground font-mono ml-2">
                        {[c.building, c.floor].filter(Boolean).join(" – ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono shrink-0">
                    <span className="text-muted-foreground">{fmt(c.previousDate)}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-yellow-500">{fmt(c.newDate)}</span>
                    <span className={c.shiftDays > 0 ? "text-red-500" : "text-emerald-500"}>
                      {c.shiftDays > 0 ? "+" : ""}{c.shiftDays}d
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* GC Task Status Management */}
      {isGc && hasTasks && (
        <TaskStatusSection tasks={tasks} projectId={projectId} />
      )}
    </div>
  );
}

// ─── Task Status Section (GC only) ────────────────────────────────────────────

const TASK_STATUS_CYCLE: Record<string, TaskStatus> = {
  OPEN: "IN_PROGRESS",
  IN_PROGRESS: "CLOSED",
  CLOSED: "OPEN",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  CLOSED: "Closed",
};

const TASK_STATUS_BADGE_CLASS: Record<string, string> = {
  OPEN: "text-muted-foreground",
  IN_PROGRESS: "text-blue-600 border-blue-400/40",
  CLOSED: "text-emerald-600 border-emerald-400/40",
};

function taskStatusBadge(status: string) {
  const cls = TASK_STATUS_BADGE_CLASS[status] ?? "text-muted-foreground";
  return <Badge variant="outline" className={`text-[10px] ${cls}`}>{TASK_STATUS_LABEL[status] ?? status}</Badge>;
}

function exportTasksCsv(tasks: Task[]) {
  const headers = ["taskId", "taskName", "building", "floor", "assignedResource", "gcInstallDate", "gcInstallDateEnd", "status", "category"];
  const rows = tasks.map((t) => [
    t.id,
    `"${(t.taskName ?? "").replace(/"/g, '""')}"`,
    t.building ?? "",
    t.floor ?? "",
    `"${(t.assignedResource ?? "").replace(/"/g, '""')}"`,
    t.gcInstallDate instanceof Timestamp ? format(t.gcInstallDate.toDate(), "yyyy-MM-dd") : "",
    t.gcInstallDateEnd instanceof Timestamp ? format(t.gcInstallDateEnd.toDate(), "yyyy-MM-dd") : "",
    t.status ?? "OPEN",
    t.category,
  ].join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "schedule-tasks.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function TaskStatusSection({ tasks, projectId }: { tasks: Task[]; projectId: string }) {
  const [localStatuses, setLocalStatuses] = useState<Record<string, TaskStatus>>({});
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [filterBuilding, setFilterBuilding] = useState<string>("ALL");

  // AI bulk edit state
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [bulkInstruction, setBulkInstruction] = useState("");
  const [bulkPreviewing, setBulkPreviewing] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkPreview, setBulkPreview] = useState<Array<{ taskId: string; taskName: string; field: string; oldValue: string; newValue: string }> | null>(null);

  // CSV re-upload state
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvUploading, setCsvUploading] = useState(false);

  const buildings = Array.from(new Set(tasks.map((t) => t.building ?? ""))).filter(Boolean).sort();

  const displayTasks = tasks.filter((t) => {
    const status = localStatuses[t.id] ?? t.status ?? "OPEN";
    if (filterStatus !== "ALL" && status !== filterStatus) return false;
    if (filterBuilding !== "ALL" && (t.building ?? "") !== filterBuilding) return false;
    return true;
  });

  async function handleStatusCycle(task: Task) {
    const current = localStatuses[task.id] ?? task.status ?? "OPEN";
    const next = TASK_STATUS_CYCLE[current] ?? "OPEN";
    setLocalStatuses((prev) => ({ ...prev, [task.id]: next }));
    setUpdating((prev) => ({ ...prev, [task.id]: true }));
    try {
      await apiUpdateTask(projectId, task.id, { status: next });
    } catch {
      setLocalStatuses((prev) => ({ ...prev, [task.id]: current as TaskStatus }));
      toast.error("Failed to update task status.");
    } finally {
      setUpdating((prev) => ({ ...prev, [task.id]: false }));
    }
  }

  async function handleBulkPreview() {
    if (!bulkInstruction.trim()) return;
    setBulkPreviewing(true);
    setBulkPreview(null);
    try {
      const result = await apiBulkEditTasks(projectId, bulkInstruction, false);
      setBulkPreview(result.changes);
      if (result.changes.length === 0) toast.info("No matching tasks found for that instruction.");
    } catch {
      toast.error("AI bulk edit failed.");
    } finally {
      setBulkPreviewing(false);
    }
  }

  async function handleBulkApply() {
    if (!bulkInstruction.trim()) return;
    setBulkApplying(true);
    try {
      const result = await apiBulkEditTasks(projectId, bulkInstruction, true);
      toast.success(`Updated ${result.updatedCount ?? 0} tasks.`);
      setBulkPreview(null);
      setBulkInstruction("");
      setShowBulkEdit(false);
    } catch {
      toast.error("Failed to apply bulk changes.");
    } finally {
      setBulkApplying(false);
    }
  }

  async function handleCsvUpload(f: File) {
    setCsvUploading(true);
    try {
      const result = await apiUploadTaskCsv(projectId, f);
      let msg = `Updated ${result.updated} tasks.`;
      if (result.unmatched.length > 0) msg += ` ${result.unmatched.length} rows unmatched.`;
      toast.success(msg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV upload failed.");
    } finally {
      setCsvUploading(false);
    }
  }

  const statusCounts = { OPEN: 0, IN_PROGRESS: 0, CLOSED: 0 };
  for (const t of tasks) {
    const s = (localStatuses[t.id] ?? t.status ?? "OPEN") as keyof typeof statusCounts;
    if (s in statusCounts) statusCounts[s]++;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Schedule Tasks</span>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => exportTasksCsv(tasks)}>
            <Download className="h-3 w-3" /> Export CSV
          </Button>
          <div className="relative">
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); }}
            />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-7 text-xs"
              onClick={() => csvInputRef.current?.click()}
              disabled={csvUploading}
            >
              {csvUploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              {csvUploading ? "Updating..." : "Import CSV"}
            </Button>
          </div>
          <Button
            size="sm"
            variant={showBulkEdit ? "secondary" : "outline"}
            className="gap-1.5 h-7 text-xs"
            onClick={() => { setShowBulkEdit(!showBulkEdit); setBulkPreview(null); }}
          >
            <Bot className="h-3 w-3" /> AI Edit
          </Button>
        </div>
      </div>

      {/* Status summary chips */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {(["ALL", "OPEN", "IN_PROGRESS", "CLOSED"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border transition-colors ${
              filterStatus === s
                ? "bg-foreground text-background border-foreground"
                : "text-muted-foreground border-border hover:border-foreground/50"
            }`}
          >
            {s === "ALL" ? `All (${tasks.length})` : `${TASK_STATUS_LABEL[s]} (${statusCounts[s]})`}
          </button>
        ))}
        {buildings.length > 0 && (
          <select
            value={filterBuilding}
            onChange={(e) => setFilterBuilding(e.target.value)}
            className="text-[11px] font-mono px-2 py-0.5 rounded-md border border-border bg-background text-muted-foreground ml-2"
          >
            <option value="ALL">All Buildings</option>
            {buildings.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
      </div>

      {/* AI Bulk Edit Panel */}
      {showBulkEdit && (
        <Card className="mb-3 border-blue-400/30 bg-blue-500/5">
          <CardContent className="py-3 px-4">
            <div className="text-xs font-semibold mb-2">AI Bulk Edit</div>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={bulkInstruction}
                onChange={(e) => { setBulkInstruction(e.target.value); setBulkPreview(null); }}
                placeholder='e.g. "mark all Building A framing tasks In Progress"'
                className="flex-1 text-sm border border-border rounded-md px-3 py-1.5 bg-background"
                onKeyDown={(e) => { if (e.key === "Enter") handleBulkPreview(); }}
              />
              <Button size="sm" onClick={handleBulkPreview} disabled={bulkPreviewing || !bulkInstruction.trim()} className="gap-1.5">
                {bulkPreviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
                Preview
              </Button>
            </div>
            {bulkPreview && bulkPreview.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-2">{bulkPreview.length} proposed change{bulkPreview.length !== 1 ? "s" : ""}:</div>
                <div className="divide-y rounded border mb-2 max-h-48 overflow-y-auto">
                  {bulkPreview.map((c, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <span className="flex-1 font-medium truncate">{c.taskName}</span>
                      <span className="text-muted-foreground shrink-0">{c.field}</span>
                      <span className="text-muted-foreground shrink-0">{c.oldValue}</span>
                      <span className="text-muted-foreground shrink-0">→</span>
                      <span className="text-blue-600 font-mono shrink-0">{c.newValue}</span>
                    </div>
                  ))}
                </div>
                <Button size="sm" onClick={handleBulkApply} disabled={bulkApplying} className="gap-1.5 w-full">
                  {bulkApplying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Apply {bulkPreview.length} Changes
                </Button>
              </div>
            )}
            {bulkPreview?.length === 0 && (
              <div className="text-xs text-muted-foreground">No matching tasks found.</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Task list */}
      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {displayTasks.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">No tasks match the current filter.</div>
            )}
            {displayTasks.map((task) => {
              const status = localStatuses[task.id] ?? task.status ?? "OPEN";
              const isUpdating = !!updating[task.id];
              return (
                <div key={task.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{task.taskName}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                      {[task.building, task.floor].filter(Boolean).join(" / ")}
                      {task.assignedResource && ` · ${task.assignedResource}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
                      {task.gcInstallDate instanceof Timestamp ? format(task.gcInstallDate.toDate(), "MMM d") : ""}
                    </span>
                    {taskStatusBadge(status)}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] px-2"
                      onClick={() => handleStatusCycle(task)}
                      disabled={isUpdating}
                    >
                      {isUpdating ? <Loader2 className="h-3 w-3 animate-spin" /> : TASK_STATUS_CYCLE[status] ? TASK_STATUS_LABEL[TASK_STATUS_CYCLE[status]] : "Open"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AlertCard({ alert: a, projectId, team }: { alert: Alert; projectId: string; team: TeamMember[] }) {
  const [showSend, setShowSend] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function sendTo(email: string, name: string) {
    setSendingTo(email);
    try {
      await apiSendAlertToMember({ email, alert: a, projectId });
      setSentTo(name);
      setShowSend(false);
      toast.success(`Alert sent to ${name}`);
    } catch {
      toast.error("Failed to send alert.");
    } finally {
      setSendingTo(null);
    }
  }

  const levelColor = alertColor(a.level);

  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-3 px-4">
        <div className="w-1 rounded-full self-stretch shrink-0 mt-0.5" style={{ background: levelColor, minHeight: 32 }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{a.title}</div>
          <div className="text-xs text-muted-foreground font-mono mt-0.5">{a.detail}</div>
          {sentTo && <div className="text-xs text-emerald-600 font-mono mt-1">✓ Sent to {sentTo}</div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge
            variant={a.level === "CRITICAL" ? "destructive" : a.level === "WARNING" ? "secondary" : "outline"}
            className="text-xs"
          >
            {a.level}
          </Badge>
          <div className="relative">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setShowSend(!showSend)}>
              <Mail className="h-3.5 w-3.5" />
            </Button>
            {showSend && (
              <div className="absolute right-0 top-full mt-1 bg-popover border rounded-lg shadow-lg z-20 min-w-44 py-1">
                <div className="text-[10px] text-muted-foreground font-mono px-3 py-1.5 uppercase tracking-wider">Send to</div>
                {team.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => sendTo(m.email, m.name)}
                    disabled={sendingTo === m.email}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    {sendingTo === m.email ? "Sending..." : m.name}
                    <span className="text-xs text-muted-foreground ml-2">{m.role}</span>
                  </button>
                ))}
                {team.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No team members yet</div>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, color = "text-foreground", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-2 px-4">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</div>}
      </CardContent>
    </Card>
  );
}
