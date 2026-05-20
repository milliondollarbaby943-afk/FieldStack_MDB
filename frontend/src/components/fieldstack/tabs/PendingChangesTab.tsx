/**
 * PendingChangesTab — GC review queue for sub date change requests.
 * Shows old vs new date, sub's notes, approve/reject buttons.
 * Conflicts (two subs requesting different dates for the same task) are flagged.
 */

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";
import { apiApprovePendingChange, apiRejectPendingChange } from "@/lib/fieldstackApi";
import type { PendingChange } from "@/types/fieldstack";

interface Props {
  projectId: string;
  changes: PendingChange[];
  onRefresh: () => void;
  isSubView?: boolean;
}

function fmtTs(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d, yyyy");
}

function statusBadge(status: string) {
  if (status === "APPROVED")
    return <Badge variant="outline" className="text-emerald-600 border-emerald-400/40 text-[10px]">Approved</Badge>;
  if (status === "REJECTED")
    return <Badge variant="outline" className="text-muted-foreground text-[10px]">Rejected</Badge>;
  if (status === "CONFLICT")
    return <Badge variant="destructive" className="text-[10px]">Conflict</Badge>;
  return <Badge variant="secondary" className="text-blue-600 text-[10px]">Pending</Badge>;
}

function ChangeCard({ change, onRefresh, isSubView }: { change: PendingChange; onRefresh: () => void; isSubView?: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [loading, setLoading] = useState(false);

  const isResolved = change.status === "APPROVED" || change.status === "REJECTED";

  async function handleApprove() {
    setLoading(true);
    try {
      await apiApprovePendingChange(change.id);
      toast.success("Date change approved.");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    setLoading(true);
    try {
      await apiRejectPendingChange(change.id, rejectReason || undefined);
      toast.success("Date change rejected.");
      setRejecting(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className={change.status === "CONFLICT" ? "border-destructive/40" : undefined}>
      <CardContent className="py-3 px-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {change.status === "CONFLICT" && (
                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
              )}
              <span className="text-sm font-medium truncate">
                {change.taskName ?? change.taskId}
              </span>
              {(change.building || change.floor) && (
                <span className="text-xs text-muted-foreground font-mono">
                  {[change.building, change.floor].filter(Boolean).join(" – ")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono flex-wrap">
              <span>
                <span className="line-through">{fmtTs(change.originalDate)}</span>
                {" → "}
                <span className="font-semibold text-foreground">{fmtTs(change.requestedDate)}</span>
              </span>
              {change.requestedByName && (
                <span>by {change.requestedByName}</span>
              )}
            </div>
            {change.notes && (
              <p className="text-xs text-muted-foreground mt-1 italic">{change.notes}</p>
            )}
            {change.status === "CONFLICT" && (
              <p className="text-xs text-destructive mt-1">
                Multiple subs have requested different dates for this task. Review and resolve.
              </p>
            )}
            {change.status === "REJECTED" && change.rejectionReason && (
              <p className="text-xs text-muted-foreground mt-1">
                Rejection reason: {change.rejectionReason}
              </p>
            )}
          </div>
          <div className="shrink-0">{statusBadge(change.status)}</div>
        </div>

        {!isResolved && !rejecting && !isSubView && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" className="gap-1.5 text-emerald-600 border-emerald-400/40 hover:bg-emerald-50" onClick={handleApprove} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Approve
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10" onClick={() => setRejecting(true)} disabled={loading}>
              <XCircle className="h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        )}

        {!isResolved && rejecting && !isSubView && (
          <div className="space-y-2 pt-1">
            <Textarea
              placeholder="Reason for rejection (optional)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="text-xs min-h-[60px] resize-none"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleReject} disabled={loading}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Confirm Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(false)} disabled={loading}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PendingChangesTab({ changes, onRefresh, isSubView }: Props) {
  const open = changes.filter((c) => c.status === "PENDING" || c.status === "CONFLICT");
  const resolved = changes.filter((c) => c.status === "APPROVED" || c.status === "REJECTED");

  if (changes.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Clock className="h-8 w-8 mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">No date change requests.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {isSubView
              ? "You haven't submitted any date change requests for this project."
              : "Subs can request a new install date from their My Tasks view."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {open.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {isSubView ? "Pending" : "Awaiting Review"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">({open.length})</span>
          </h3>
          {open.map((c) => (
            <ChangeCard key={c.id} change={c} onRefresh={onRefresh} isSubView={isSubView} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Resolved
            <span className="ml-2 text-xs font-normal">({resolved.length})</span>
          </h3>
          {resolved.map((c) => (
            <ChangeCard key={c.id} change={c} onRefresh={onRefresh} isSubView={isSubView} />
          ))}
        </div>
      )}
    </div>
  );
}
