/**
 * Dashboard — project list with daily briefing and stats.
 * Drag-and-drop a schedule PDF to auto-create a project.
 */

import { useState, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useProjects } from "@/hooks/useProjects";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, AlertTriangle, CheckCircle2, Clock, FolderOpen, Upload } from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { Timestamp } from "firebase/firestore";
import type { Project } from "@/types/fieldstack";
import { NewProjectDialog } from "@/components/fieldstack/NewProjectDialog";
import { apiCreateProjectFromSchedule } from "@/lib/fieldstackApi";

const VALID_EXTS = [".pdf", ".txt", ".csv"];

function alertDot(p: Project) {
  const c = p.alertCounts;
  if (!c) return "bg-muted";
  if (c.critical > 0) return "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]";
  if (c.warning > 0) return "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]";
  return "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
}

function statusBadge(p: Project) {
  if ((p.alertCounts?.critical ?? 0) > 0)
    return <Badge variant="destructive">{p.alertCounts!.critical} critical</Badge>;
  if ((p.alertCounts?.warning ?? 0) > 0)
    return <Badge variant="secondary" className="text-yellow-600 border-yellow-400/40">{p.alertCounts!.warning} warning</Badge>;
  return <Badge variant="outline" className="text-emerald-600 border-emerald-400/40">on track</Badge>;
}

function fmtDate(ts: Timestamp | undefined) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d");
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { company } = useCompany();
  const { projects, loading } = useProjects();
  const [showNewProject, setShowNewProject] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeProjects = projects.filter((p) => p.status === "ACTIVE");
  const totalCritical = projects.reduce((s, p) => s + (p.alertCounts?.critical ?? 0), 0);
  const totalWarning = projects.reduce((s, p) => s + (p.alertCounts?.warning ?? 0), 0);

  async function handleScheduleFile(f: File) {
    const ext = "." + (f.name.split(".").pop()?.toLowerCase() ?? "");
    if (!VALID_EXTS.includes(ext)) {
      toast.error("Unsupported file type. Drop a PDF, TXT, or CSV schedule.");
      return;
    }
    setParsing(true);
    try {
      const result = await apiCreateProjectFromSchedule(f);
      toast.success(
        `Project created: ${result.tasksCreated} tasks, ${result.orderItemsCreated} orders`
      );
      navigate(`/projects/${result.projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to parse schedule.");
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragOver(false);
  }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleScheduleFile(f);
  }

  return (
    <div
      className="p-6 relative min-h-full"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Parsing overlay */}
      {parsing && (
        <div className="fixed inset-0 z-50 bg-background/90 flex items-center justify-center">
          <div className="border rounded-2xl px-16 py-14 text-center bg-card shadow-xl max-w-sm">
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-4" />
            <div className="text-base font-semibold mb-2">Parsing schedule…</div>
            <div className="text-sm text-muted-foreground">
              AI is extracting project info and tasks. This takes about 20–40 seconds.
            </div>
          </div>
        </div>
      )}

      {/* Drop overlay */}
      {dragOver && !parsing && (
        <div className="fixed inset-0 z-50 bg-background/90 flex items-center justify-center pointer-events-none">
          <div className="border-2 border-dashed border-primary rounded-2xl px-20 py-16 text-center bg-primary/5">
            <div className="text-5xl mb-4 opacity-60">📄</div>
            <div className="text-lg font-semibold text-primary mb-2">Drop schedule to create a project</div>
            <div className="text-sm text-muted-foreground">FieldStack will extract project name, GC, and all tasks</div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleScheduleFile(f);
        }}
      />

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1 font-mono">
              {company?.name} · {format(new Date(), "EEEE, MMMM d, yyyy")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
              className="gap-2"
            >
              <Upload className="h-4 w-4" />
              From Schedule
            </Button>
            <Button onClick={() => setShowNewProject(true)} disabled={parsing} className="gap-2">
              <Plus className="h-4 w-4" /> New Project
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Stats */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"
      >
        <StatCard label="Active Projects" value={activeProjects.length} icon={<FolderOpen className="h-4 w-4" />} />
        <StatCard
          label="Critical Alerts"
          value={totalCritical}
          icon={<AlertTriangle className="h-4 w-4" />}
          color={totalCritical > 0 ? "text-red-500" : "text-emerald-500"}
          sub="Past order-by date"
        />
        <StatCard
          label="Warning Alerts"
          value={totalWarning}
          icon={<Clock className="h-4 w-4" />}
          color={totalWarning > 0 ? "text-yellow-500" : "text-emerald-500"}
          sub="Due within 14 days"
        />
        <StatCard
          label="On Track"
          value={projects.filter((p) => !p.alertCounts?.critical && !p.alertCounts?.warning).length}
          icon={<CheckCircle2 className="h-4 w-4" />}
          color="text-emerald-500"
          sub="No active alerts"
        />
      </motion.div>

      {/* Project list */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Projects</span>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading projects...
          </div>
        )}

        {!loading && projects.length === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card
              className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
              onClick={() => fileInputRef.current?.click()}
            >
              <CardContent className="py-12 text-center">
                <Upload className="h-9 w-9 mx-auto mb-3 text-primary opacity-60" />
                <p className="text-sm font-semibold mb-1">From Schedule PDF</p>
                <p className="text-xs text-muted-foreground">
                  Drop a GC schedule — AI extracts project, tasks, and order dates automatically.
                </p>
              </CardContent>
            </Card>
            <Card
              className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
              onClick={() => setShowNewProject(true)}
            >
              <CardContent className="py-12 text-center">
                <Plus className="h-9 w-9 mx-auto mb-3 text-muted-foreground opacity-60" />
                <p className="text-sm font-semibold mb-1">Manual Entry</p>
                <p className="text-xs text-muted-foreground">
                  Create a project manually, then upload the schedule from the project page.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="flex flex-col gap-2">
            {projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`}>
                <Card className="hover:border-border/80 transition-colors cursor-pointer">
                  <CardContent className="flex items-center justify-between gap-4 py-4 px-5">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${alertDot(p)}`} />
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                          {p.address} · GC: {p.gcName}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {statusBadge(p)}
                      <span className="text-xs text-muted-foreground font-mono hidden sm:block">
                        {p.status}
                      </span>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </motion.div>

      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color = "text-foreground",
  sub,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color?: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={`${color} opacity-70`}>{icon}</span>
        </div>
        <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}
