/**
 * TimelineTab — all tasks sorted by install date, filterable by our tasks vs all.
 * GC view: assign line items to connected sub companies.
 */

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Timestamp, doc, updateDoc } from "firebase/firestore";
import { format } from "date-fns";
import { ChevronDown, Users } from "lucide-react";
import { toast } from "sonner";
import { firestore } from "@/lib/firebase";
import type { Task } from "@/types/fieldstack";
import { TASK_CATEGORY_LABELS } from "@/types/fieldstack";
import type { ConnectedSub } from "@/hooks/useProjectConnections";

interface Props {
  tasks: Task[];
  companyId: string;
  projectId: string;
  connectedSubs: ConnectedSub[];
}

function fmt(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d, yyyy");
}

async function assignTask(
  companyId: string,
  projectId: string,
  taskId: string,
  subCompanyId: string | null
) {
  const taskRef = doc(
    firestore,
    `companies/${companyId}/projects/${projectId}/tasks/${taskId}`
  );
  await updateDoc(taskRef, { assignedSubCompanyId: subCompanyId });
}

interface AssignButtonProps {
  task: Task;
  companyId: string;
  projectId: string;
  connectedSubs: ConnectedSub[];
  subName: string | null;
}

function AssignButton({
  task,
  companyId,
  projectId,
  connectedSubs,
  subName,
}: AssignButtonProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSelect(subCompanyId: string | null) {
    setSaving(true);
    setOpen(false);
    try {
      await assignTask(companyId, projectId, task.id, subCompanyId);
      toast.success(
        subCompanyId
          ? `Assigned to ${connectedSubs.find((s) => s.id === subCompanyId)?.name}`
          : "Assignment cleared"
      );
    } catch {
      toast.error("Failed to save assignment.");
    } finally {
      setSaving(false);
    }
  }

  if (connectedSubs.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          className="h-6 px-2 text-xs gap-1 font-normal"
        >
          {subName ?? "Assign"}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="end">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1">
          Assign to sub
        </div>
        {connectedSubs.map((sub) => (
          <button
            key={sub.id}
            onClick={() => handleSelect(sub.id)}
            className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors ${
              task.assignedSubCompanyId === sub.id
                ? "font-medium text-primary"
                : ""
            }`}
          >
            {sub.name}
          </button>
        ))}
        {task.assignedSubCompanyId && (
          <>
            <div className="border-t my-1" />
            <button
              onClick={() => handleSelect(null)}
              className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground rounded hover:bg-accent transition-colors"
            >
              Clear assignment
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TimelineTab({
  tasks,
  companyId,
  projectId,
  connectedSubs,
}: Props) {
  const [filter, setFilter] = useState<"ours" | "all">("ours");
  const [bulkGroupBy, setBulkGroupBy] = useState<
    "building" | "floor" | "category"
  >("building");
  const [bulkGroup, setBulkGroup] = useState<string>("");
  const [bulkSubId, setBulkSubId] = useState<string>("");
  const [bulkSaving, setBulkSaving] = useState(false);

  const displayed = filter === "ours" ? tasks.filter((t) => t.isOurTask) : tasks;

  // Build unique values for bulk assign
  const buildings = [...new Set(tasks.map((t) => t.building).filter(Boolean))] as string[];
  const floors = [...new Set(tasks.map((t) => t.floor).filter(Boolean))] as string[];
  const categories = [...new Set(tasks.map((t) => t.category))] as string[];

  const groupOptions =
    bulkGroupBy === "building"
      ? buildings
      : bulkGroupBy === "floor"
      ? floors
      : categories;

  async function handleBulkAssign() {
    if (!bulkGroup || !bulkSubId) return;
    const matching = tasks.filter((t) => {
      if (bulkGroupBy === "building") return t.building === bulkGroup;
      if (bulkGroupBy === "floor") return t.floor === bulkGroup;
      return t.category === bulkGroup;
    });
    if (matching.length === 0) {
      toast.error("No tasks match that selection.");
      return;
    }
    setBulkSaving(true);
    try {
      await Promise.all(
        matching.map((t) => assignTask(companyId, projectId, t.id, bulkSubId))
      );
      const subName = connectedSubs.find((s) => s.id === bulkSubId)?.name;
      toast.success(`Assigned ${matching.length} tasks to ${subName}`);
      setBulkGroup("");
      setBulkSubId("");
    } catch {
      toast.error("Bulk assign failed.");
    } finally {
      setBulkSaving(false);
    }
  }

  if (tasks.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="text-3xl mb-3 opacity-40">📅</div>
          <p className="text-sm text-muted-foreground">
            No tasks yet. Upload a schedule to populate the timeline.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Schedule Timeline</h3>
        <Tabs
          value={filter}
          onValueChange={(v) => setFilter(v as "ours" | "all")}
        >
          <TabsList className="h-7">
            <TabsTrigger value="ours" className="text-xs h-6 px-3">
              Our Tasks
            </TabsTrigger>
            <TabsTrigger value="all" className="text-xs h-6 px-3">
              All Tasks
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Bulk assign panel */}
      {connectedSubs.length > 0 && (
        <Card>
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground font-medium">
                Bulk assign
              </span>
              <Select
                value={bulkGroupBy}
                onValueChange={(v) => {
                  setBulkGroupBy(v as "building" | "floor" | "category");
                  setBulkGroup("");
                }}
              >
                <SelectTrigger className="h-7 text-xs w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="building">By building</SelectItem>
                  <SelectItem value="floor">By floor</SelectItem>
                  <SelectItem value="category">By category</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={bulkGroup}
                onValueChange={setBulkGroup}
                disabled={groupOptions.length === 0}
              >
                <SelectTrigger className="h-7 text-xs w-36">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {groupOptions.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {bulkGroupBy === "category"
                        ? TASK_CATEGORY_LABELS[opt as keyof typeof TASK_CATEGORY_LABELS] ?? opt
                        : opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">→</span>
              <Select
                value={bulkSubId}
                onValueChange={setBulkSubId}
              >
                <SelectTrigger className="h-7 text-xs w-40">
                  <SelectValue placeholder="Select sub…" />
                </SelectTrigger>
                <SelectContent>
                  {connectedSubs.map((sub) => (
                    <SelectItem key={sub.id} value={sub.id}>
                      {sub.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-7 text-xs px-3"
                disabled={!bulkGroup || !bulkSubId || bulkSaving}
                onClick={handleBulkAssign}
              >
                Apply
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {displayed.map((t) => {
          const subName =
            t.assignedSubCompanyId
              ? (connectedSubs.find((s) => s.id === t.assignedSubCompanyId)?.name ??
                null)
              : null;

          return (
            <Card key={t.id}>
              <CardContent className="flex items-center justify-between gap-4 py-3 px-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {t.taskName}
                    </span>
                    {t.isOurTask && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 text-blue-600 border-blue-400/40"
                      >
                        Ours
                      </Badge>
                    )}
                    {subName && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 text-violet-600 border-violet-400/40"
                      >
                        {subName}
                      </Badge>
                    )}
                  </div>
                  {(t.building || t.floor) && (
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">
                      {[t.building, t.floor].filter(Boolean).join(" – ")}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 text-xs font-mono text-muted-foreground">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider mb-0.5">
                      Install
                    </div>
                    <div>{fmt(t.gcInstallDate)}</div>
                  </div>
                  {t.assignedResource && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider mb-0.5">
                        Resource
                      </div>
                      <div>{t.assignedResource}</div>
                    </div>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {TASK_CATEGORY_LABELS[t.category] ?? t.category}
                  </Badge>
                  {connectedSubs.length > 0 && (
                    <AssignButton
                      task={t}
                      companyId={companyId}
                      projectId={projectId}
                      connectedSubs={connectedSubs}
                      subName={subName}
                    />
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {displayed.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No {filter === "ours" ? "cabinet/countertop" : ""} tasks found.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
