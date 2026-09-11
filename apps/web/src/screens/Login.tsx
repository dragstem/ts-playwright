import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@ts-playwright/ui";
import { useAuth } from "../auth";

// Login + self-register on one screen. The first registered user becomes the admin.
export function Login() {
  const { login, loginMfa, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // When the password is accepted for an MFA-enabled user, switch to the code step.
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        const result = await login(loginValue, password);
        if (result.mfa_required && result.mfa_token) {
          setMfaToken(result.mfa_token);
          return;
        }
      } else {
        await register(loginValue, password, displayName || undefined);
      }
      navigate("/projects", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await loginMfa(mfaToken, code);
      navigate("/projects", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <div className="tsp-app" style={{ maxWidth: 380 }}>
        <h1>Two-factor</h1>
        <form onSubmit={submitMfa} className="tsp-card" style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--text-muted)" }}>Authentication code (or recovery code)</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" required />
          </label>
          {error && <div style={{ color: "var(--status-failed)" }}>{error}</div>}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "…" : "Verify"}
          </Button>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMfaToken("");
              setCode("");
              setError("");
            }}
            style={{ color: "var(--text-muted)", fontSize: 13 }}
          >
            ← Back
          </a>
        </form>
      </div>
    );
  }

  return (
    <div className="tsp-app" style={{ maxWidth: 380 }}>
      <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} className="tsp-card" style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--text-muted)" }}>Login (email)</span>
          <input value={loginValue} onChange={(e) => setLoginValue(e.target.value)} autoComplete="username" required />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--text-muted)" }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>
        {mode === "register" && (
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--text-muted)" }}>Display name (optional)</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        {error && <div style={{ color: "var(--status-failed)" }}>{error}</div>}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Register"}
        </Button>
      </form>
      <p style={{ color: "var(--text-muted)", marginTop: 12 }}>
        {mode === "login" ? "No account yet? " : "Already have an account? "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setError("");
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "Register" : "Sign in"}
        </a>
      </p>
    </div>
  );
}
