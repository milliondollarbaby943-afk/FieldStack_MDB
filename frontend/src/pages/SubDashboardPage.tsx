/**
 * SubDashboardPage — shown to SUB company users instead of the GC Dashboard.
 *
 * Shows only tasks assigned to this sub company, grouped by project.
 * Sub can update task step status and notes for steps where canEditBy is
 * 'SUB' or 'BOTH'. GC-only fields (pricing, orders) are hidden.
 */

import { useState } from "react";
import { doc, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  HardHat,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useSubTasks } from "@/hooks/useSubTasks";
import { useCompany } from "@/contexts/CompanyContext";
import type { Task, TaskStep } from "@/types/fieldstack";
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
  // If canEditBy is not set, default conservative (GC only).
  // INSTALL and PUNCH_LIST are sub-editable by convention.
  const editBy = step.canEditBy;
  if (editBy === "SUB" || editBy === "BOTH") return true;
  if (editBy == null && (step.stepType === "INSTALL" || step.stepType === "PUNCH_LIST" || step.stepType === "CONFIRM_DELIVERY")) return true;
  return false;
}

interface StepRowProps {
  step: TaskStep;
  gcCompanyId: string;
}

function StepRow({ step, gcCompanyId }: StepRowProps) {
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

      {/* Notes */}
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

interface TaskCardProps {
  task: Task;
  steps: TaskStep[];
  gcCompanyId: string;
}

function TaskCard({ task, steps, gcCompanyId }: TaskCardProps) {
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

export default function SubDashboardPage() {
  const { company } = useCompany();
  const { groups, loading } = useSubTasks();

  const totalTasks = groups.reduce((s, g) => s + g.tasks.length, 0);

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <HardHat className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">My Projects</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Tasks assigned to {company?.name ?? "your company"} across all active projects.
        </p>
      </motion.div>

      {loading && (
        <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading your tasks…
        </div>
      )}

      {!loading && totalTasks === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <HardHat className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-sm font-medium mb-1">No tasks assigned yet</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Your GC partners will assign tasks to your company once they connect you to a project.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && groups.map((group) => (
        <div key={`${group.gcCompanyId}/${group.projectId}`} className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-base font-semibold">{group.projectName}</h2>
              <p className="text-xs text-muted-foreground">{group.tasks.length} assigned task{group.tasks.length !== 1 ? "s" : ""}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {group.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                steps={group.steps}
                gcCompanyId={group.gcCompanyId}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
