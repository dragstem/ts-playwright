import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import { api } from "../api";
import { useAuth } from "../auth";
import { toastMessage, useToast } from "./Toast";

interface Enrollment {
  secret: string;
  otpauth_uri: string;
}

// Account two-factor (TOTP) management: enroll (show secret → confirm a code → reveal one-time
// recovery codes) and disable (requires a current code). Reads mfa_enabled from the signed-in user.
export function MfaPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startEnroll = () =>
    run(async () => {
      setRecovery(null);
      setEnrollment(await api.post<Enrollment>("/api/auth/mfa/enroll", {}));
    });

  const confirmEnroll = () =>
    run(async () => {
      const result = await api.post<{ recovery_codes: string[] }>("/api/auth/mfa/confirm", { code });
      setRecovery(result.recovery_codes);
      setEnrollment(null);
      setCode("");
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Two-factor enabled");
    });

  const disable = () =>
    run(async () => {
      await api.post("/api/auth/mfa/disable", { code });
      setCode("");
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Two-factor disabled");
    });

  return (
    <div className="tsp-card" style={{ display: "grid", gap: 8, maxWidth: 480, marginBottom: 16 }}>
      <strong>
        Two-factor authentication{" "}
        <span className="tsp-badge" data-status={user?.mfa_enabled ? "passed" : "queued"}>
          {user?.mfa_enabled ? "on" : "off"}
        </span>
      </strong>

      {!user?.mfa_enabled && !enrollment && (
        <Button variant="primary" disabled={busy} onClick={startEnroll}>
          Enable 2FA
        </Button>
      )}

      {enrollment && (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Add this secret to your authenticator app, then enter a code to confirm.
          </span>
          <code style={{ fontSize: 13, wordBreak: "break-all" }}>{enrollment.secret}</code>
          <code style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>
            {enrollment.otpauth_uri}
          </code>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={busy || !code} onClick={confirmEnroll}>
              Confirm
            </Button>
            <Button variant="secondary" onClick={() => setEnrollment(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {recovery && (
        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--status-timeout)" }}>
            Save these one-time recovery codes — they are shown only once:
          </span>
          <pre style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{recovery.join("\n")}</pre>
        </div>
      )}

      {user?.mfa_enabled && (
        <div style={{ display: "flex", gap: 8 }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="current code to disable" inputMode="numeric" />
          <Button variant="danger" disabled={busy || !code} onClick={disable}>
            Disable
          </Button>
        </div>
      )}
    </div>
  );
}
