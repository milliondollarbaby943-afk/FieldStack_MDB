/**
 * AcceptInvitePage — shown at /invite/accept?token=...
 *
 * Accessible to both authenticated and unauthenticated users.
 * Reads company membership directly from Firestore so it works
 * outside the CompanyProvider tree.
 *
 * Flow:
 *   1. Show invite details from token.
 *   2. Not logged in → redirect to /login?next=current URL.
 *   3. Logged in, no company → prompt to finish company setup.
 *   4. Logged in with company → Accept button.
 *   5. After accept → redirect to dashboard.
 */

import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { collection, query, where, getDocs, getDoc, doc } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle, Building2, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { apiGetInviteInfo, apiAcceptInvite } from "@/lib/fieldstackApi";

interface InviteInfo {
  gcCompanyName: string;
  gcProjectName: string;
  subEmail: string;
}

interface CompanyInfo {
  id: string;
  name: string;
}

export default function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";

  const { user, loading: authLoading } = useAuth();

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [userCompany, setUserCompany] = useState<CompanyInfo | null | undefined>(undefined);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!token) {
      setInviteError("No invitation token found. Please use the link from your email.");
      setLoadingInfo(false);
      return;
    }
    apiGetInviteInfo(token)
      .then(setInviteInfo)
      .catch((err: Error) => setInviteError(err.message ?? "Invalid or expired invitation."))
      .finally(() => setLoadingInfo(false));
  }, [token]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setUserCompany(null); return; }

    const q = query(collection(firestore, "companyMembers"), where("uid", "==", user.uid));
    getDocs(q).then(async (snap) => {
      if (snap.empty) { setUserCompany(null); return; }
      const companyId = snap.docs[0].data().companyId as string;
      const companyDoc = await getDoc(doc(firestore, "companies", companyId)).catch(() => null);
      setUserCompany(companyDoc?.exists() ? { id: companyDoc.id, name: companyDoc.data()!.name as string } : null);
    }).catch(() => setUserCompany(null));
  }, [user, authLoading]);

  async function handleAccept() {
    if (!token) return;
    setAccepting(true);
    try {
      await apiAcceptInvite(token);
      setAccepted(true);
      toast.success("You're now connected! Welcome to the project.");
      setTimeout(() => navigate("/"), 2000);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to accept invitation. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  const loading = authLoading || loadingInfo || userCompany === undefined;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-primary text-primary-foreground font-bold text-2xl mb-4">
            F
          </div>
          <h1 className="text-2xl font-bold tracking-tight">FieldStack</h1>
          <p className="text-muted-foreground text-sm mt-1">Sub-contractor Invitation</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Link2 className="h-5 w-5 text-primary" />
              Project Invitation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && inviteError && (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <XCircle className="h-10 w-10 text-destructive" />
                <p className="text-sm text-muted-foreground">{inviteError}</p>
              </div>
            )}

            {!loading && accepted && (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <CheckCircle className="h-10 w-10 text-green-500" />
                <p className="font-medium">Connection activated!</p>
                <p className="text-sm text-muted-foreground">Redirecting to your dashboard…</p>
              </div>
            )}

            {!loading && inviteInfo && !accepted && (
              <>
                <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">From:</span>
                    <span className="font-medium">{inviteInfo.gcCompanyName}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground pl-6">Project:</span>
                    <span className="font-medium">{inviteInfo.gcProjectName}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground pl-6">Invited:</span>
                    <span className="font-mono text-xs">{inviteInfo.subEmail}</span>
                  </div>
                </div>

                {!user && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground text-center">
                      Sign in or create an account to accept this invitation.
                    </p>
                    <Button
                      className="w-full"
                      onClick={() =>
                        navigate(
                          `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
                        )
                      }
                    >
                      Sign In / Create Account
                    </Button>
                  </div>
                )}

                {user && !userCompany && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground text-center">
                      You need to set up your company before accepting this invitation.
                    </p>
                    <Button className="w-full" onClick={() => navigate("/")}>
                      Set Up My Company
                    </Button>
                  </div>
                )}

                {user && userCompany && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground text-center">
                      Connect <span className="font-medium text-foreground">{userCompany.name}</span> to{" "}
                      <span className="font-medium text-foreground">{inviteInfo.gcProjectName}</span> and
                      start collaborating.
                    </p>
                    <Button className="w-full" onClick={handleAccept} disabled={accepting}>
                      {accepting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Accepting…
                        </>
                      ) : (
                        "Accept Invitation"
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
