/**
 * MyTasksPage — shows task steps assigned to the current user across all projects.
 * Subs can request a date change for any task from here.
 */

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, CheckSquare, CalendarClock } from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { toast } from "sonner";
import { apiGetMyTasks, apiRequestDateChange } from "@/lib/fieldstackApi";
import { STEP_TYPE_LABELS } from "@/types/fieldstack";
import { useAuth } from "@/contexts/AuthContext";

interface MyTask {
  id: string;
  taskId?: string;
  projectId?: string;
  stepType: string;
  status: string;
  building?: string;
  floor?: string;
  dueDate?: string;
  installDate?: string;
  projectName: string;
  notes?: string;
}

function statusBadge(status: string) {
  if (status === "COMPLETE") return <Badge variant="outline" className="text-emerald-600 border-emerald-400/40 text-[10px]">Complete</Badge>;
  if (status === "IN_PROGRESS") return <Badge variant="secondary" className="text-blue-600 text-[10px]">In Progress</Badge>;
  if (status === "BLOCKED") return <Badge variant="destructive" className="text-[10px]">Blocked</Badge>;
  return <Badge variant="outline" className="text-muted-foreground text-[10px]">Pending</Badge>;
}

interface DateChangeDialogProps {
  task: MyTask;
  userName: string;
  onClose: () => void;
}

function DateChangeDialog({ task, userName, onClose }: DateChangeDialogProps) {
  const [newDate, setNewDate] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!newDate) { toast.error("Please select a new date."); return; }
    if (!task.taskId || !task.projectId) { toast.error("Task information missing."); return; }

    setLoading(true);
    try {
      await apiRequestDateChange({
        projectId: task.projectId,
        taskId: task.taskId,
        requestedDate: newDate,
        notes: notes || undefined,
        requestedByName: userName,
      });
      toast.success("Date change request submitted. The GC will review it.");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit request.");
    } finally {
      setLoading(false);
    }
  }

  const currentDate = task.installDate
    ? format(new Date(task.installDate), "MMM d, yyyy")
    : task.dueDate
    ? format(new Date(task.dueDate), "MMM d, yyyy")
    : null;

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !loading) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Request Date Change</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <p className="text-sm font-medium mb-0.5">
              {STEP_TYPE_LABELS[task.stepType as keyof typeof STEP_TYPE_LABELS] ?? task.stepType}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              {task.projectName}
              {(task.building || task.floor) && ` · ${[task.building, task.floor].filter(Boolean).join(" – ")}`}
            </p>
          </div>
          {currentDate && (
            <p className="text-xs text-muted-foreground">
              Current date: <span className="font-mono">{currentDate}</span>
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="new-date" className="text-xs">New install date</Label>
            <Input
              id="new-date"
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes" className="text-xs">Notes (optional)</Label>
            <Textarea
              id="notes"
              placeholder="Explain why the date needs to change…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="text-xs min-h-[72px] resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MyTasksPage() {
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateChangeTask, setDateChangeTask] = useState<MyTask | null>(null);
  const { user, profile } = useAuth();

  const userName = profile?.displayName ?? user?.displayName ?? user?.email ?? "";

  useEffect(() => {
    apiGetMyTasks()
      .then((data) => setTasks(data as MyTask[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">My Tasks</h1>
        <p className="text-sm text-muted-foreground mt-1">Task steps assigned to you across all projects.</p>
      </motion.div>

      {loading && (
        <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading tasks...
        </div>
      )}

      {!loading && tasks.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center">
            <CheckSquare className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">No tasks assigned to you yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Task steps can be assigned from the Workflow tab on each project.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && tasks.length > 0 && (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex items-start justify-between gap-4 py-3 px-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-medium">
                      {STEP_TYPE_LABELS[t.stepType as keyof typeof STEP_TYPE_LABELS] ?? t.stepType}
                    </span>
                    {(t.building || t.floor) && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {[t.building, t.floor].filter(Boolean).join(" – ")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">{t.projectName}</div>
                  {t.notes && <div className="text-xs text-muted-foreground mt-1 italic">{t.notes}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.dueDate && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {format(new Date(t.dueDate), "MMM d")}
                    </span>
                  )}
                  {statusBadge(t.status)}
                  {t.taskId && t.projectId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() => setDateChangeTask(t)}
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      Request Date Change
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dateChangeTask && (
        <DateChangeDialog
          task={dateChangeTask}
          userName={userName}
          onClose={() => setDateChangeTask(null)}
        />
      )}
    </div>
  );
}
