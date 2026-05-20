import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail, Upload } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format, differenceInDays } from "date-fns";
import { apiSendAlerts, apiSendAlertToMember } from "@/lib/fieldstackApi";
import { alertColor } from "@/lib/alerts";
import { useCompany } from "@/contexts/CompanyContext";
import type { Alert, Task, ScheduleChange, TeamMember } from "@/types/fieldstack";

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
