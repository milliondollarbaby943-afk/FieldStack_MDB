/**
 * ScheduleEditTab — Airtable-style inline editable schedule for GC users.
 * Click any cell to edit inline. Dirty rows highlighted amber until saved.
 */

import { useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";
import { apiUpdateTask } from "@/lib/fieldstackApi";
import type { Task, TaskStatus } from "@/types/fieldstack";

type EditableFields = {
  taskName: string;
  building: string;
  floor: string;
  assignedResource: string;
  gcInstallDate: string;
  gcInstallDateEnd: string;
  status: TaskStatus;
};

type DirtyRow = Partial<EditableFields> & { taskId: string };

function toDateStr(ts: Timestamp | null | undefined): string {
  if (!ts) return "";
  try { return format(ts.toDate(), "yyyy-MM-dd"); } catch { return ""; }
}

function taskToEditable(task: Task): EditableFields {
  return {
    taskName: task.taskName,
    building: task.building ?? "",
    floor: task.floor ?? "",
    assignedResource: task.assignedResource ?? "",
    gcInstallDate: toDateStr(task.gcInstallDate),
    gcInstallDateEnd: toDateStr(task.gcInstallDateEnd),
    status: task.status ?? "OPEN",
  };
}

interface Props {
  projectId: string;
  tasks: Task[];
}

export function ScheduleEditTab({ projectId, tasks }: Props) {
  const [dirty, setDirty] = useState<Record<string, Partial<EditableFields>>>({});
  const [saving, setSaving] = useState(false);
  const [filterBuilding, setFilterBuilding] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [searchText, setSearchText] = useState("");

  const buildings = Array.from(new Set(tasks.map((t) => t.building ?? ""))).filter(Boolean).sort();

  const displayTasks = tasks.filter((t) => {
    const row = { ...taskToEditable(t), ...(dirty[t.id] ?? {}) };
    if (filterBuilding !== "ALL" && row.building !== filterBuilding) return false;
    if (filterStatus !== "ALL" && row.status !== filterStatus) return false;
    if (searchText && !row.taskName.toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  const dirtyCount = Object.keys(dirty).length;

  function setField<K extends keyof EditableFields>(taskId: string, field: K, value: EditableFields[K]) {
    setDirty((prev) => ({
      ...prev,
      [taskId]: { ...(prev[taskId] ?? {}), [field]: value },
    }));
  }

  const handleDiscard = useCallback(() => {
    setDirty({});
    toast.info("Changes discarded.");
  }, []);

  async function handleSave() {
    const dirtyRows: DirtyRow[] = Object.entries(dirty).map(([taskId, fields]) => ({ taskId, ...fields }));
    if (dirtyRows.length === 0) return;

    setSaving(true);
    let saved = 0;
    let failed = 0;

    for (const row of dirtyRows) {
      const { taskId, status, gcInstallDate, gcInstallDateEnd, assignedResource } = row;
      const update: Parameters<typeof apiUpdateTask>[2] = {};
      if (status !== undefined) update.status = status;
      if (gcInstallDate !== undefined) update.gcInstallDate = gcInstallDate || undefined;
      if (gcInstallDateEnd !== undefined) update.gcInstallDateEnd = gcInstallDateEnd || undefined;
      if (assignedResource !== undefined) update.assignedResource = assignedResource;

      try {
        await apiUpdateTask(projectId, taskId, update);
        saved++;
      } catch {
        failed++;
      }
    }

    setSaving(false);
    if (failed === 0) {
      toast.success(`Saved ${saved} task${saved !== 1 ? "s" : ""}.`);
      setDirty({});
    } else {
      toast.error(`${failed} task${failed !== 1 ? "s" : ""} failed to save.`);
    }
  }

  if (tasks.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground text-sm">
          No tasks yet. Upload a schedule to get started.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="text-sm border border-border rounded-md px-3 py-1.5 bg-background w-48"
          />
          {buildings.length > 0 && (
            <select
              value={filterBuilding}
              onChange={(e) => setFilterBuilding(e.target.value)}
              className="text-sm border border-border rounded-md px-2 py-1.5 bg-background text-muted-foreground"
            >
              <option value="ALL">All Buildings</option>
              {buildings.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="text-sm border border-border rounded-md px-2 py-1.5 bg-background text-muted-foreground"
          >
            <option value="ALL">All Statuses</option>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="CLOSED">Closed</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <>
              <Badge variant="secondary" className="text-amber-600 border-amber-400/40 text-xs">
                {dirtyCount} unsaved change{dirtyCount !== 1 ? "s" : ""}
              </Badge>
              <Button size="sm" variant="ghost" onClick={handleDiscard} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Save {dirtyCount} Change{dirtyCount !== 1 ? "s" : ""}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground font-mono">
                <th className="text-left px-4 py-2 font-medium">Task Name</th>
                <th className="text-left px-3 py-2 font-medium">Building</th>
                <th className="text-left px-3 py-2 font-medium">Floor</th>
                <th className="text-left px-3 py-2 font-medium">Resource</th>
                <th className="text-left px-3 py-2 font-medium">Install Date</th>
                <th className="text-left px-3 py-2 font-medium">End Date</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {displayTasks.map((task) => {
                const base = taskToEditable(task);
                const overrides = dirty[task.id] ?? {};
                const row = { ...base, ...overrides };
                const isDirty = !!dirty[task.id];
                const rowClass = isDirty ? "bg-amber-500/5 border-l-2 border-l-amber-400" : "";

                return (
                  <tr key={task.id} className={`border-b hover:bg-muted/30 transition-colors ${rowClass}`}>
                    <td className="px-4 py-1.5 font-medium max-w-[220px]">
                      <span className="truncate block">{row.taskName}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineText value={row.building} onChange={(v) => setField(task.id, "building", v)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineText value={row.floor} onChange={(v) => setField(task.id, "floor", v)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineText value={row.assignedResource} onChange={(v) => setField(task.id, "assignedResource", v)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineDate value={row.gcInstallDate} onChange={(v) => setField(task.id, "gcInstallDate", v)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineDate value={row.gcInstallDateEnd} onChange={(v) => setField(task.id, "gcInstallDateEnd", v)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        value={row.status}
                        onChange={(e) => setField(task.id, "status", e.target.value as TaskStatus)}
                        className="text-xs border border-border rounded px-1.5 py-0.5 bg-background"
                      >
                        <option value="OPEN">Open</option>
                        <option value="IN_PROGRESS">In Progress</option>
                        <option value="CLOSED">Closed</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
              {displayTasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    No tasks match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground text-right">{displayTasks.length} of {tasks.length} tasks shown</p>
    </div>
  );
}

function InlineText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        defaultValue={value}
        onBlur={(e) => { onChange(e.target.value); setEditing(false); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }}
        className="text-xs border border-border rounded px-1.5 py-0.5 bg-background w-full min-w-[80px]"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="text-xs text-left px-1 py-0.5 rounded hover:bg-muted w-full min-h-[22px] font-mono truncate"
    >
      {value || <span className="text-muted-foreground/40">—</span>}
    </button>
  );
}

function InlineDate({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs border border-border rounded px-1.5 py-0.5 bg-background font-mono"
    />
  );
}
