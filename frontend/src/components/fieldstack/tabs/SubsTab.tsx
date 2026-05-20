/**
 * SubsTab — GC-only tab for managing subcontractor connections on a project.
 * Lets the GC invite subs by email; shows pending and active connections.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserPlus, Building2, Clock, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { apiInviteSub } from "@/lib/fieldstackApi";
import { useProjectConnections } from "@/hooks/useProjectConnections";
import type { Task } from "@/types/fieldstack";

interface Props {
  projectId: string;
  tasks: Task[];
}

export function SubsTab({ projectId, tasks }: Props) {
  const { connectedSubs, loading } = useProjectConnections(projectId);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const ourTaskCount = tasks.filter((t) => t.isOurTask).length;

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email address.");
      return;
    }
    setInviting(true);
    try {
      await apiInviteSub(projectId, trimmed);
      toast.success(`Invitation sent to ${trimmed}.`);
      setEmail("");
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? "Failed to send invite.");
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Invite form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Invite Subcontractor
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Enter the sub's email address. They'll receive a link to create an account and will be
            automatically assigned to the {ourTaskCount} task{ourTaskCount !== 1 ? "s" : ""} in
            your scope on this project.
          </p>
          <form onSubmit={handleInvite} className="flex gap-2">
            <Input
              type="email"
              placeholder="sub@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
              disabled={inviting}
            />
            <Button type="submit" disabled={inviting || !email.trim()}>
              {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send Invite"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Connections list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Connected Subs
            {!loading && connectedSubs.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px]">{connectedSubs.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && connectedSubs.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No subs connected yet. Send an invite above.
            </p>
          )}
          {!loading && connectedSubs.length > 0 && (
            <div className="space-y-2">
              {connectedSubs.map((sub) => (
                <div key={sub.connectionId} className="flex items-center justify-between py-2 border-b last:border-b-0">
                  <div>
                    <div className="text-sm font-medium">{sub.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{sub.subEmail}</div>
                  </div>
                  {sub.status === "ACTIVE" ? (
                    <Badge variant="outline" className="text-emerald-600 border-emerald-400/40 text-[10px] gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 border-amber-400/40 text-[10px] gap-1">
                      <Clock className="h-3 w-3" /> Pending
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
