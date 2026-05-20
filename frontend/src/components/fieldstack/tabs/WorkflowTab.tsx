/**
 * WorkflowTab — 6-step task chain per building/floor.
 * Shop Drawings → Submissions → Order Materials → Confirm Delivery → Install → Punch List
 * GC can click any step to cycle its status (PENDING → IN_PROGRESS → COMPLETE → PENDING).
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, Clock, AlertCircle, Circle } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";
import type { TaskStep, TeamMember } from "@/types/fieldstack";
import { STEP_TYPE_LABELS } from "@/types/fieldstack";
import { apiUpdateStep } from "@/lib/fieldstackApi";

const STEP_ORDER = ["SHOP_DRAWINGS", "SUBMISSIONS", "ORDER_MATERIALS", "CONFIRM_DELIVERY", "INSTALL", "PUNCH_LIST"] as const;

function statusIcon(status: string) {
  if (status === "COMPLETE") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === "IN_PROGRESS") return <Clock className="h-4 w-4 text-blue-500" />;
  if (status === "BLOCKED") return <AlertCircle className="h-4 w-4 text-red-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
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

interface StepRowProps {
  step: TaskStep;
  assigneeName?: string;
}

function StepRow({ step, assigneeName }: StepRowProps) {
  const [updating, setUpdating] = useState(false);
  const dueDate = step.dueDate instanceof Timestamp ? format(step.dueDate.toDate(), "MMM d") : null;

  async function handleStatusToggle() {
    setUpdating(true);
    try {
      await apiUpdateStep(step.id, { status: nextStatus(step.status) });
    } catch {
      toast.error("Failed to update step.");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-1.5">
      {statusIcon(step.status)}
      <div className="flex-1 min-w-0">
        <span className="text-sm">{STEP_TYPE_LABELS[step.stepType] ?? step.stepType}</span>
        {step.notes && (
          <span className="text-xs text-muted-foreground ml-2 truncate">{step.notes}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {assigneeName && (
          <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{assigneeName}</span>
        )}
        {dueDate && (
          <span className="text-xs text-muted-foreground font-mono">{dueDate}</span>
        )}
        {statusBadge(step.status)}
        <Button
          size="sm"
          variant={step.status === "COMPLETE" ? "ghost" : "outline"}
          className="h-6 text-[11px] px-2 shrink-0"
          onClick={handleStatusToggle}
          disabled={updating}
        >
          {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : nextStatusLabel(step.status)}
        </Button>
      </div>
    </div>
  );
}

interface Props {
  projectId: string;
  steps: TaskStep[];
  team: TeamMember[];
}

export function WorkflowTab({ projectId, steps, team }: Props) {
  void projectId;

  // Group steps by taskId (one chain per task, unique per upload)
  const groups = new Map<string, TaskStep[]>();
  for (const s of steps) {
    const key = s.taskId ?? ([s.building, s.floor].filter(Boolean).join("/") || "General");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  // Sort groups by building → floor → taskName for consistent ordering
  const sortedGroups = Array.from(groups.entries()).sort(([, aSteps], [, bSteps]) => {
    const a = aSteps[0];
    const b = bSteps[0];
    const buildingCmp = (a.building ?? "").localeCompare(b.building ?? "");
    if (buildingCmp !== 0) return buildingCmp;
    const floorCmp = (a.floor ?? "").localeCompare(b.floor ?? "");
    if (floorCmp !== 0) return floorCmp;
    return (a.taskName ?? "").localeCompare(b.taskName ?? "");
  });

  if (steps.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="text-3xl mb-3 opacity-40">🔧</div>
          <p className="text-sm text-muted-foreground">No workflow steps yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Upload a schedule to auto-generate task chains.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">Task Workflow</h3>
        <p className="text-xs text-muted-foreground">
          6-step chain per task: Shop Drawings → Submissions → Order → Confirm Delivery → Install → Punch List
        </p>
      </div>

      {sortedGroups.map(([groupKey, groupSteps]) => {
        const rep = groupSteps[0];
        const headerTitle = rep.taskName || [rep.building, rep.floor].filter(Boolean).join(" / ") || "General";
        const subInfo = [rep.assignedResource, [rep.building, rep.floor].filter(Boolean).join(" / ")].filter(Boolean);
        return (
          <Card key={groupKey}>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold">{headerTitle}</CardTitle>
              {subInfo.length > 0 && (
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{subInfo.join(" · ")}</p>
              )}
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="divide-y">
                {STEP_ORDER.map((stepType) => {
                  const step = groupSteps.find((s) => s.stepType === stepType);
                  if (!step) return null;
                  const assignee = team.find((m) => m.id === step.assignedToId);
                  return (
                    <StepRow
                      key={stepType}
                      step={step}
                      assigneeName={assignee?.name}
                    />
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
