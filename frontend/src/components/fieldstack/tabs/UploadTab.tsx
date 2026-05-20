/**
 * UploadTab — drag-and-drop schedule upload with smart parsing.
 */

import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { apiUploadSchedule } from "@/lib/fieldstackApi";

interface Props {
  projectId: string;
  gcCompanyId?: string;
  onUploaded: () => void;
}

export function UploadTab({ projectId, gcCompanyId, onUploaded }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ tasksCreated: number; orderItemsCreated: number; version: number; changesDetected: number } | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  async function handleFile(f: File) {
    const validExts = [".pdf", ".xlsx", ".xls", ".txt", ".csv"];
    if (!validExts.some((ext) => f.name.toLowerCase().endsWith(ext))) {
      setError("Unsupported file type. Use PDF, XLSX, or plain text.");
      return;
    }
    setUploading(true);
    setError("");
    setResult(null);
    try {
      const data = await apiUploadSchedule(projectId, f, gcCompanyId);
      setResult(data);
      toast.success("Schedule parsed successfully!");
      setTimeout(() => onUploaded(), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setUploading(false);
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
    if (f) handleFile(f);
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">Upload Schedule</h3>
        <p className="text-xs text-muted-foreground">
          Upload a GC lookahead schedule. FieldStack will extract all tasks, compute order-by dates, and detect changes from the previous version.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.xlsx,.xls,.txt,.csv"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />

      <Card
        className={`border-dashed cursor-pointer transition-all ${dragOver ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-muted/30"}`}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <CardContent className="py-14 text-center">
          {uploading ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex items-center gap-2">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-2.5 h-2.5 rounded-full bg-primary animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
              <div>
                <div className="text-sm font-medium">Reading your schedule…</div>
                <div className="text-xs text-muted-foreground mt-1">Extracting tasks and dates</div>
              </div>
            </div>
          ) : result ? (
            <div className="flex flex-col items-center gap-3">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              <div>
                <div className="text-sm font-medium text-emerald-600">Schedule parsed successfully!</div>
                <div className="text-xs text-muted-foreground font-mono mt-1 flex gap-4 justify-center">
                  <span>{result.tasksCreated} tasks</span>
                  <span>{result.orderItemsCreated} orders</span>
                  <span>v{result.version}</span>
                  {result.changesDetected > 0 && <span className="text-yellow-500">{result.changesDetected} changes</span>}
                </div>
              </div>
            </div>
          ) : (
            <>
              <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-40" />
              <div className="text-base font-semibold mb-2">
                {dragOver ? "Drop to upload" : "Drop your GC schedule here"}
              </div>
              <div className="text-sm text-muted-foreground mb-5">or click to browse</div>
              <Button variant="outline" className="gap-2" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                <Upload className="h-4 w-4" /> Choose File
              </Button>
              <div className="text-xs text-muted-foreground mt-3 font-mono">PDF, XLSX, XLS, TXT, CSV</div>
            </>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-2 py-3 px-4">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-sm text-destructive">{error}</span>
          </CardContent>
        </Card>
      )}

      <Card className="bg-muted/30">
        <CardContent className="py-4 px-4">
          <div className="text-xs font-semibold mb-2">How it works</div>
          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
            <li>Upload any GC lookahead schedule (PDF, XLSX, or text)</li>
            <li>FieldStack reads the document and identifies all tasks</li>
            <li>Cabinet and countertop tasks are identified and extracted</li>
            <li>Order-by dates are computed from install dates + lead times</li>
            <li>Changes from the previous version are detected and flagged</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
