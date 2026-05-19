import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { config } from "@/lib/config";
import { LayoutGrid, MapPin, TrendingUp, Star, CheckCircle2, Eye, EyeOff, Zap } from "lucide-react";
import { motion } from "framer-motion";

type View = "signup" | "login" | "forgot" | "forgot-sent";

const FEATURES = [
  { icon: LayoutGrid, text: "Manage your items and resources" },
  { icon: TrendingUp, text: "Track progress and activity" },
  { icon: MapPin, text: "Access from anywhere" },
  { icon: Star, text: "Save and organize your work" },
];

function getStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score, label: "Weak", color: "bg-red-500" };
  if (score <= 2) return { score, label: "Fair", color: "bg-amber-500" };
  if (score <= 3) return { score, label: "Good", color: "bg-yellow-400" };
  return { score, label: "Strong", color: "bg-emerald-500" };
}

export default function Login() {
  const { signIn, signUp, signInWithGoogle, sendPasswordReset, resendVerificationEmail } = useAuth();
  const [searchParams] = useSearchParams();

  const [view, setView] = useState<View>(() =>
    searchParams.get("mode") === "signup" ? "signup" : "login"
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);

  const signupStrength = getStrength(password);

  // Sync view if URL param changes
  useEffect(() => {
    const mode = searchParams.get("mode");
    if (mode === "signup") setView("signup");
    else setView("login");
  }, [searchParams]);

  const clearForm = () => {
    setEmail("");
    setPassword("");
    setConfirm("");
    setError("");
    setWarning("");
    setShowPassword(false);
  };

  const switchView = (v: View) => {
    clearForm();
    setView(v);
  };

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // user closed — silent
      } else if (code === "auth/popup-blocked") {
        setError("Popup was blocked by your browser. Please allow popups for this site and try again.");
      } else if (code === "auth/unauthorized-domain") {
        setError("This domain is not authorized for Google sign-in. Contact support.");
      } else if (code === "auth/operation-not-allowed") {
        setError("Google sign-in is not enabled. Contact support.");
      } else if (code === "auth/access-denied" || code === "access_denied") {
        setError("Google sign-in was denied. If you see an 'unverified app' warning, click Advanced → proceed to sign in.");
      } else {
        setError(`Google sign-in failed (${code || "unknown error"}). Please try again.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setWarning("");
    setLoading(true);
    try {
      const result = await signIn(email, password);
      if (result.needsVerification) {
        setWarning("Your email isn't verified yet. Check your inbox, or resend below.");
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password" ||
        code === "auth/user-not-found"
      ) {
        setError("Invalid email or password.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      await signUp(email, password);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/email-already-in-use") {
        setError("An account with this email already exists.");
      } else if (code === "auth/weak-password") {
        setError("Password must be at least 8 characters.");
      } else if (code === "auth/invalid-email") {
        setError("Please enter a valid email address.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await sendPasswordReset(resetEmail);
      setView("forgot-sent");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/invalid-email") {
        setError("Please enter a valid email address.");
      } else {
        setView("forgot-sent");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* ── Left panel: value prop (hidden on mobile) ── */}
      <div className="hidden lg:flex lg:w-[52%] gradient-bg flex-col justify-between p-12 text-white relative overflow-hidden">
        {/* Subtle background orbs */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-[-15%] right-[-5%] w-[480px] h-[480px] rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-[-10%] left-[-8%] w-[360px] h-[360px] rounded-full bg-white/8 blur-3xl" />
        </div>

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-md bg-white/20 flex items-center justify-center text-white font-bold text-base">
            {config.appName[0]}
          </div>
          <span className="text-xl font-bold tracking-tight">{config.appName}</span>
        </div>

        {/* Main copy */}
        <div className="relative z-10 space-y-10">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium text-white/90">
              <Zap className="h-3.5 w-3.5" />
              Built for productivity
            </div>
            <h1 className="text-4xl font-bold leading-tight tracking-tight">
              Get more done,<br />faster.
            </h1>
            <p className="text-white/70 text-base leading-relaxed max-w-sm">
              {config.appName} gives you the tools to manage your work and stay on top of what matters.
            </p>
          </div>

          <div className="space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 shrink-0">
                  <Icon className="h-4 w-4 text-white" />
                </div>
                <span className="text-white/85 text-sm font-medium">{text}</span>
              </div>
            ))}
          </div>

          {/* Social proof */}
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {["bg-pink-400", "bg-amber-400", "bg-emerald-400", "bg-sky-400"].map((c, i) => (
                <div
                  key={i}
                  className={`h-8 w-8 rounded-full ${c} border-2 border-white/30 flex items-center justify-center text-xs font-bold text-white`}
                >
                  {["J", "M", "R", "S"][i]}
                </div>
              ))}
            </div>
            <p className="text-white/70 text-sm">
              Join <span className="text-white font-semibold">users</span> already getting things done
            </p>
          </div>
        </div>

        {/* Bottom badge */}
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm text-white/85">
            <CheckCircle2 className="h-4 w-4 text-white/90" />
            Free to start · No credit card required
          </div>
        </div>
      </div>

      {/* ── Right panel: auth form ── */}
      <div className="flex-1 flex items-center justify-center p-6 bg-background">
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="w-full max-w-sm"
        >
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center justify-center gap-2 mb-8">
            <div className="h-9 w-9 rounded-md gradient-bg flex items-center justify-center text-white font-bold text-base">
              {config.appName[0]}
            </div>
            <span className="text-xl font-bold tracking-tight gradient-text">
              {config.appName}
            </span>
          </div>

          {/* ── SIGNUP VIEW ── */}
          {view === "signup" && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight">Start for free</h2>
                <p className="text-muted-foreground text-sm">No credit card required. Free plan available.</p>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full h-11 gap-2 font-medium"
                onClick={handleGoogle}
                disabled={loading}
              >
                <GoogleIcon />
                Continue with Google
              </Button>

              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground px-1">or</span>
                <Separator className="flex-1" />
              </div>

              <form onSubmit={handleSignUp} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => { e.target.setCustomValidity(""); setEmail(e.target.value); }}
                    onInvalid={(e) => (e.target as HTMLInputElement).setCustomValidity("Please enter a valid email address.")}
                    required
                    autoComplete="email"
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signup-password">Password</Label>
                  <div className="relative">
                    <Input
                      id="signup-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Min. 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className="h-11 pr-10"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      tabIndex={-1}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {password.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="flex gap-1">
                        {[1, 2, 3, 4].map((i) => (
                          <div
                            key={i}
                            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                              signupStrength.score >= i ? signupStrength.color : "bg-muted"
                            }`}
                          />
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Strength: <span className="font-medium text-foreground">{signupStrength.label}</span>
                      </p>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signup-confirm">Confirm password</Label>
                  <Input
                    id="signup-confirm"
                    type={showPassword ? "text" : "password"}
                    placeholder="Re-enter password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="h-11"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full h-11 font-semibold" disabled={loading}>
                  {loading ? "Creating account…" : "Create free account"}
                </Button>
              </form>

              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <button
                  type="button"
                  className="text-primary font-medium hover:underline underline-offset-4"
                  onClick={() => switchView("login")}
                >
                  Sign in
                </button>
              </p>
              <p className="text-center text-xs text-muted-foreground">
                By signing up, you agree to our{" "}
                <a href={`${config.appUrl}/terms`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">Terms</a>
                {" "}and{" "}
                <a href={`${config.appUrl}/privacy`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">Privacy Policy</a>.
              </p>
            </div>
          )}

          {/* ── LOGIN VIEW ── */}
          {view === "login" && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
                <p className="text-muted-foreground text-sm">Sign in to continue.</p>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full h-11 gap-2 font-medium"
                onClick={handleGoogle}
                disabled={loading}
              >
                <GoogleIcon />
                Continue with Google
              </Button>

              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground px-1">or</span>
                <Separator className="flex-1" />
              </div>

              <form onSubmit={handleSignIn} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    id="login-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => { e.target.setCustomValidity(""); setEmail(e.target.value); }}
                    onInvalid={(e) => (e.target as HTMLInputElement).setCustomValidity("Please enter a valid email address.")}
                    required
                    autoComplete="email"
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="login-password">Password</Label>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
                      onClick={() => switchView("forgot")}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                      autoComplete="current-password"
                      className="h-11 pr-10"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      tabIndex={-1}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                {warning && (
                  <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    {warning}{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4 hover:opacity-80"
                      onClick={async () => {
                        await resendVerificationEmail();
                        setWarning("Verification email sent. Check your inbox.");
                      }}
                    >
                      Resend email
                    </button>
                  </p>
                )}
                <Button type="submit" className="w-full h-11 font-semibold" disabled={loading}>
                  {loading ? "Signing in…" : "Sign in"}
                </Button>
              </form>

              <p className="text-center text-sm text-muted-foreground">
                Don't have an account?{" "}
                <button
                  type="button"
                  className="text-primary font-medium hover:underline underline-offset-4"
                  onClick={() => switchView("signup")}
                >
                  Sign up free
                </button>
              </p>
            </div>
          )}

          {/* ── FORGOT PASSWORD VIEW ── */}
          {view === "forgot" && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight">Reset your password</h2>
                <p className="text-muted-foreground text-sm">
                  Enter your email and we'll send a reset link right over.
                </p>
              </div>
              <form onSubmit={handlePasswordReset} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="reset-email">Email</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="you@example.com"
                    value={resetEmail}
                    onChange={(e) => { e.target.setCustomValidity(""); setResetEmail(e.target.value); }}
                    onInvalid={(e) => (e.target as HTMLInputElement).setCustomValidity("Please enter a valid email address.")}
                    required
                    autoComplete="email"
                    className="h-11"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full h-11 font-semibold" disabled={loading}>
                  {loading ? "Sending…" : "Send reset link"}
                </Button>
              </form>
              <p className="text-center">
                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
                  onClick={() => switchView("login")}
                >
                  Back to sign in
                </button>
              </p>
            </div>
          )}

          {/* ── FORGOT SENT VIEW ── */}
          {view === "forgot-sent" && (
            <div className="space-y-5 text-center">
              <div className="flex justify-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-7 w-7 text-primary" />
                </div>
              </div>
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight">Check your inbox</h2>
                <p className="text-muted-foreground text-sm">
                  If an account exists for{" "}
                  <span className="font-medium text-foreground">{resetEmail}</span>,
                  you'll get a reset link shortly.
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full h-11"
                onClick={() => switchView("login")}
              >
                Back to sign in
              </Button>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
