/**
 * GcUploadPage — public schedule upload page for GCs.
 * No login required — the JWT token in the URL is the auth.
 * Route: /gc-upload?token=...
 *
 * GCs receive this link in a weekly email and can drop their schedule
 * without logging into the app.
 */

import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, XCircle, Upload } from "lucide-react";
import { UploadTab } from "@/components/fieldstack/tabs/UploadTab";
import { apiGetGcUploadLink } from "@/lib/fieldstackApi";

interface ProjectInfo {
  projectId: string;
  gcCompanyId: string;
  projectName: string;
}

export default function GcUploadPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No token provided. Please use the link from your email.");
      setLoading(false);
      return;
    }

    apiGetGcUploadLink(token)
      .then(setProjectInfo)
      .catch((err: Error) => setError(err.message ?? "This link is invalid or has expired."))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center">
            <XCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
            <h2 className="text-lg font-semibold mb-2">Link Error</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (uploaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-4 text-emerald-500" />
            <h2 className="text-lg font-semibold mb-2">Schedule Uploaded</h2>
            <p className="text-sm text-muted-foreground">
              Your schedule has been uploaded. Your team will review the changes.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!projectInfo) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-primary text-primary-foreground font-bold text-2xl mb-4">
            F
          </div>
          <h1 className="text-2xl font-bold tracking-tight">FieldStack</h1>
          <p className="text-muted-foreground text-sm mt-1">Schedule Upload</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Upload className="h-5 w-5 text-primary" />
              {projectInfo.projectName}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UploadTab
              projectId={projectInfo.projectId}
              gcCompanyId={projectInfo.gcCompanyId}
              onUploaded={() => setUploaded(true)}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
