import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { CompanyProvider, useCompany } from "@/contexts/CompanyContext";
import { AppLayout } from "@/components/AppLayout";
import { VerifyEmailScreen } from "@/components/VerifyEmailScreen";
import { ProfileSetupScreen } from "@/components/ProfileSetupScreen";
import Login from "./pages/Login";
import { ProtectedAdminRoute } from "@/components/ProtectedAdminRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazy, Suspense } from "react";
import Settings from "./pages/Settings";
import Billing from "./pages/Billing";
import Help from "./pages/Help";
import AuthAction from "./pages/AuthAction";
import NotFound from "./pages/NotFound";
// FieldStack pages
import Dashboard from "./pages/Dashboard";
import ProjectDetail from "./pages/ProjectDetail";
import TeamPage from "./pages/TeamPage";
import FieldStackSettings from "./pages/FieldStackSettings";
import MyTasksPage from "./pages/MyTasksPage";
import CompanySetup from "./pages/CompanySetup";
import MagicLinkAction from "./pages/MagicLinkAction";
import AcceptInvitePage from "./pages/AcceptInvitePage";
import SubDashboardPage from "./pages/SubDashboardPage";

const SystemAdmin = lazy(() => import("./pages/SystemAdmin"));

const queryClient = new QueryClient();

function AppRoutes() {
  const { company, loading: companyLoading } = useCompany();

  if (companyLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // New user with no company — show onboarding
  if (!company) {
    return <CompanySetup />;
  }

  const isSub = company.companyType === "SUB";

  return (
    <AppLayout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={isSub ? <SubDashboardPage /> : <Dashboard />} />
          {!isSub && <Route path="/projects/:id" element={<ProjectDetail />} />}
          {!isSub && <Route path="/team" element={<TeamPage />} />}
          <Route path="/my-tasks" element={<MyTasksPage />} />
          <Route path="/settings" element={<FieldStackSettings />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/help" element={<Help />} />
          <Route
            path="/admin"
            element={
              <ProtectedAdminRoute
                element={
                  <Suspense fallback={null}>
                    <SystemAdmin />
                  </Suspense>
                }
              />
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </AppLayout>
  );
}

function AuthGate() {
  const { user, loading, isNewUser, emailVerified } = useAuth();

  const isEmailProvider = user?.providerData.some((p) => p.providerId === "password") ?? false;
  const needsVerification = isEmailProvider && !emailVerified;

  if (loading) {
    if (isNewUser) return <ProfileSetupScreen />;
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) return <Login />;
  // if (needsVerification) return <VerifyEmailScreen />;

  return (
    <CompanyProvider>
      <AppRoutes />
    </CompanyProvider>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/auth/action" element={<AuthAction />} />
              <Route path="/tasks/action" element={<MagicLinkAction />} />
              <Route path="/invite/accept" element={<AcceptInvitePage />} />
              <Route path="*" element={<AuthGate />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
