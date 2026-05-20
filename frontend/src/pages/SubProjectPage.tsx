/**
 * SubProjectPage — project detail view for sub company users.
 *
 * Shows only data the sub has access to: their assigned tasks, steps,
 * schedule upload, and their own date change requests.
 * No destructive actions (no delete project, no order management, no alerts).
 *
 * URL: /projects/:id?gc={gcCompanyId}
 */

import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { doc, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Upload,
  CalendarClock,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { UploadTab } from "@/components/fieldstack/tabs/UploadTab";
import { PendingChangesTab } from "@/components/fieldstack/tabs/PendingChangesTab";
import { useSubTasks } from "@/hooks/useSubTasks";
import { useCompany } from "@/contexts/CompanyContext";
import { apiGetPendingChanges } from "@/lib/fieldstackApi";
import type { Task, TaskStep, PendingChange } from "@/types/fieldstack";
import { TASK_CATEGORY_LABELS, STEP_TYPE_LABELS } from "@/types/fieldstack";

function fmt(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d, yyyy");
}

function statusIcon(status: string) {
  if (status === "COMPLETE") return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
  if (status === "IN_PROGRESS") return <Clock className="h-4 w-4 text-blue-500 shrink-0" />;
  if (status === "BLOCKED") return <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />;
  return <Circle className="h-4 w-4 text-muted-foreground shrink-0" />;
}

function statusBadge(status: string) {
  if (status === "COMPLETE") return <Badge variant="outline" className="text-emerald-600 border-emerald-400/40 text-[10px]">Complete</Badge>;
  if (status === "IN_PROGRESS") return <Badge variant="secondary" className="text-blue-600 border-blue-400/40 text-[10px]">In Progress</Badge>;
  if (status === "BLOCKED") return <Badge variant="destructive" className="text-[10px]">Blocked</Badge>;
  return <Badge variant="outline" className="text-muted-foreground text-[10px]">Pending</Badge>;
}

function nextStatus(current: string): string {
  if (current === "PENDING") return "IN_PROGRESS";
  if (current === "IN_PROGRESS") return "COMPLETE";
  return "PENDING";
}

function nextStatusLabel(current: string): string {
  if (current === "PENDING") return "Start";
  if (current === "IN_PROGRESS") return "Mark Complete";
  return "Reset";
}

function canSubEdit(step: TaskStep): boolean {
  const editBy = step.canEditBy;
  if (editBy === "SUB" || editBy === "BOTH") return true;
  if (editBy == null && (step.stepType === "INSTALL" || step.stepType === "PUNCH_LIST" || step.stepType === "CONFIRM_DELIVERY")) return true;
  return false;
}

function StepRow({ step, gcCompanyId }: { step: TaskStep; gcCompanyId: string }) {
  const [updating, setUpdating] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(step.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);

  const editable = canSubEdit(step);
  const stepPath = `companies/${gcCompanyId}/projects/${step.projectId}/taskSteps/${step.id}`;

  async function handleStatusToggle() {
    setUpdating(true);
    try {
      const next = nextStatus(step.status);
      await updateDoc(doc(firestore, stepPath), {
        status: next,
        updatedAt: serverTimestamp(),
        ...(next === "COMPLETE" ? { completedAt: serverTimestamp() } : {}),
        ...(next === "PENDING" ? { completedAt: null } : {}),
      });
    } catch {
      toast.error("Failed to update status.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    try {
      await updateDoc(doc(firestore, stepPath), { notes: notes || null, updatedAt: serverTimestamp() });
      setEditingNotes(false);
      toast.success("Notes saved.");
    } catch {
      toast.error("Failed to save notes.");
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-2 border-b last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {statusIcon(step.status)}
          <span className="text-sm">{STEP_TYPE_LABELS[step.stepType] ?? step.stepType}</span>
          {statusBadge(step.status)}
          {step.dueDate && (
            <span className="text-xs text-muted-foreground font-mono">
              Due {fmt(step.dueDate)}
            </span>
          )}
        </div>
        {editable && (
          <Button
            size="sm"
            variant={step.status === "COMPLETE" ? "ghost" : "outline"}
            className="h-6 text-[11px] px-2 shrink-0"
            onClick={handleStatusToggle}
            disabled={updating}
          >
            {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : nextStatusLabel(step.status)}
          </Button>
        )}
      </div>

      {editable && (
        editingNotes ? (
          <div className="flex flex-col gap-1.5 pl-6">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes…"
              className="text-xs min-h-16 resize-none"
              rows={3}
            />
            <div className="flex gap-1.5">
              <Button size="sm" className="h-6 text-[11px] px-2" onClick={handleSaveNotes} disabled={savingNotes}>
                {savingNotes ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={() => { setNotes(step.notes ?? ""); setEditingNotes(false); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            className="pl-6 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setEditingNotes(true)}
          >
            {step.notes ? step.notes : "+ Add notes"}
          </button>
        )
      )}
      {!editable && step.notes && (
        <p className="pl-6 text-xs text-muted-foreground">{step.notes}</p>
      )}
    </div>
  );
}

function TaskCard({ task, steps, gcCompanyId }: { task: Task; steps: TaskStep[]; gcCompanyId: string }) {
  const [open, setOpen] = useState(false);
  const taskSteps = steps.filter((s) => s.taskId === task.id);
  const subSteps = taskSteps.filter(canSubEdit);
  const completed = subSteps.filter((s) => s.status === "COMPLETE").length;
  const total = subSteps.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardContent className="flex items-center justify-between gap-4 py-3 px-4 cursor-pointer hover:bg-muted/30 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">{task.taskName}</span>
                <Badge variant="outline" className="text-[10px]">
                  {TASK_CATEGORY_LABELS[task.category] ?? task.category}
                </Badge>
                {total > 0 && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {completed}/{total} steps
                  </span>
                )}
              </div>
              {(task.building || task.floor) && (
                <div className="text-xs text-muted-foreground font-mono mt-0.5">
                  {[task.building, task.floor].filter(Boolean).join(" – ")}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0 text-xs font-mono text-muted-foreground">
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider mb-0.5">Install</div>
                <div>{fmt(task.gcInstallDate)}</div>
              </div>
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
          </CardContent>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-4 pb-2">
            {taskSteps.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">No workflow steps for this task.</p>
            ) : (
              taskSteps.map((step) => (
                <StepRow key={step.id} step={step} gcCompanyId={gcCompanyId} />
              ))
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export default function SubProjectPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { company } = useCompany();
  const { groups, loading: tasksLoading } = useSubTasks();

  const urlGcId = searchParams.get("gc") ?? "";
  const group = groups.find(
    (g) => g.projectId === projectId && (urlGcId ? g.gcCompanyId === urlGcId : true)
  );
  const gcCompanyId = urlGcId || group?.gcCompanyId || "";

  const [activeTab, setActiveTab] = useState("tasks");
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  const loadPending = useCallback(async () => {
    if (!projectId || !gcCompanyId) return;
    setPendingLoading(true);
    try {
      const data = await apiGetPendingChanges(projectId, gcCompanyId);
      setPendingChanges(data as PendingChange[]);
    } catch {
      // silent — shows empty state
    } finally {
      setPendingLoading(false);
    }
  }, [projectId, gcCompanyId]);

  useEffect(() => {
    if (activeTab === "pending") loadPending();
  }, [activeTab, loadPending]);

  const projectName = group?.projectName ?? "Project";
  const tasks = group?.tasks ?? [];
  const steps = group?.steps ?? [];

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) =>
    steps.filter((s) => s.taskId === t.id && canSubEdit(s)).every((s) => s.status === "COMPLETE")
    && steps.some((s) => s.taskId === t.id && canSubEdit(s))
  ).length;

  if (!tasksLoading && !group && gcCompanyId) {
    return (
      <div className="p-6 max-w-3xl">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" /> Back to My Projects
        </Link>
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm font-medium mb-1">Project not found</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              This project may no longer be active or you may not have tasks assigned here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" /> My Projects
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
          {!tasksLoading && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {totalTasks} assigned task{totalTasks !== 1 ? "s" : ""}
              {totalTasks > 0 && ` · ${completedTasks}/${totalTasks} complete`}
            </p>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="tasks" className="gap-1.5">
              My Tasks
            </TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              Upload Schedule
            </TabsTrigger>
            <TabsTrigger value="pending" className="gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" />
              My Requests
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tasks">
            {tasksLoading && (
              <div className="flex items-center gap-3 text-muted-foreground py-10 justify-center">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading tasks…
              </div>
            )}

            {!tasksLoading && tasks.length === 0 && (
              <Card>
                <CardContent className="py-14 text-center">
                  <p className="text-sm font-medium mb-1">No tasks assigned to you here</p>
                  <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                    Your GC will assign tasks to your company from the project schedule.
                  </p>
                </CardContent>
              </Card>
            )}

            {!tasksLoading && tasks.length > 0 && (
              <div className="flex flex-col gap-2">
                {tasks
                  .slice()
                  .sort((a, b) => {
                    const aMs = a.gcInstallDate?.seconds ?? 0;
                    const bMs = b.gcInstallDate?.seconds ?? 0;
                    return aMs - bMs;
                  })
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      steps={steps}
                      gcCompanyId={gcCompanyId}
                    />
                  ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="upload">
            {projectId && (
              <UploadTab
                projectId={projectId}
                gcCompanyId={gcCompanyId}
                onUploaded={() => {
                  toast.success("Schedule uploaded. Your GC will review changes.");
                  setActiveTab("pending");
                  loadPending();
                }}
              />
            )}
          </TabsContent>

          <TabsContent value="pending">
            {pendingLoading ? (
              <div className="flex items-center gap-3 text-muted-foreground py-10 justify-center">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading requests…
              </div>
            ) : (
              projectId && (
                <PendingChangesTab
                  projectId={projectId}
                  changes={pendingChanges}
                  onRefresh={loadPending}
                  isSubView
                />
              )
            )}
          </TabsContent>
        </Tabs>
      </motion.div>
    </div>
  );
}
