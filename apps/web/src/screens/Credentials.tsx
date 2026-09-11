import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, SecretField } from "@ts-playwright/ui";
import type { ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { ScopeLegend } from "../components/ScopeLegend";
import { useT } from "../i18n";

interface MaskedAccount {
  login: string;
  project_id: string | null;
  has_password: boolean;
  has_totp: boolean;
  updated_at: string;
}

// Stand credentials (the login/password/2FA of tested stands, used by {server_*} placeholders).
// Write-only: secrets are never shown — only "configured" flags. A test-code button proves a
// TOTP secret is valid without revealing it.
export function Credentials() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<MaskedAccount[]>("/api/accounts") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectRecord[]>("/api/projects") });
  const projectName = (id: string | null) =>
    id ? projects.data?.find((p) => p.id === id)?.name ?? id : "global";

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [scope, setScope] = useState(""); // "" = global, else project_id
  const [testCode, setTestCode] = useState("");

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string | null> = { login: login.trim(), project_id: scope || null };
      if (password) body.password = password;
      if (otp) body["2fa_otp"] = otp;
      return api.post("/api/accounts", body);
    },
    onSuccess: () => {
      setPassword("");
      setOtp("");
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const del = useMutation({
    mutationFn: (account: MaskedAccount) =>
      api.del(
        `/api/accounts/${encodeURIComponent(account.login)}?project_id=${encodeURIComponent(account.project_id ?? "")}`
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] })
  });

  const generateCode = async (l: string) => {
    setTestCode("");
    try {
      const r = await api.post<{ code: string; expires_in_sec: number }>("/api/accounts/code", { login: l });
      setTestCode(`${l}: ${r.code} (valid ${r.expires_in_sec}s)`);
    } catch (e) {
      toast.error(toastMessage(e));
    }
  };

  return (
    <div>
      <h1>{t("page.credentials")}</h1>
      <p style={{ color: "var(--text-muted)" }}>
        Login / password / 2FA of tested stands. Secrets are write-only — leave a field empty to keep the stored value.
      </p>
      <ScopeLegend />

      <div className="tsp-card" style={{ display: "grid", gap: 8, maxWidth: 480, marginBottom: 16 }}>
        <input placeholder={t("form.login")} value={login} onChange={(e) => setLogin(e.target.value)} />
        <SecretField
          placeholder={t("form.password_keep")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SecretField
          placeholder="2FA TOTP secret (base32, leave empty to keep)"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
        />
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("form.scope")}</label>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">{t("form.scope_global")}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={!login.trim() || save.isPending} onClick={() => save.mutate()}>
          {t("action.save")}
        </Button>
      </div>

      {testCode && (
        <div className="tsp-card" style={{ marginBottom: 16, fontFamily: "var(--mono)" }}>🔐 {testCode}</div>
      )}

      {accounts.isLoading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {(accounts.data ?? []).map((a) => (
          <div key={`${a.project_id ?? "global"}:${a.login}`} className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <strong style={{ flex: 1 }}>{a.login}</strong>
            <span className="tsp-badge" data-status={a.project_id ? "running" : "queued"}>
              {projectName(a.project_id)}
            </span>
            <span className="tsp-badge" data-status={a.has_password ? "passed" : "queued"}>
              {a.has_password ? "password set" : "no password"}
            </span>
            <span className="tsp-badge" data-status={a.has_totp ? "passed" : "queued"}>
              {a.has_totp ? "2FA set" : "no 2FA"}
            </span>
            {a.has_totp && <Button onClick={() => void generateCode(a.login)}>Test code</Button>}
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm({ message: `Delete stand credential "${a.login}"?`, confirmLabel: t("action.delete"), danger: true })) {
                  del.mutate(a);
                }
              }}
            >
              {t("action.delete")}
            </Button>
          </div>
        ))}
        {accounts.data?.length === 0 && <p style={{ color: "var(--text-muted)" }}>No stand credentials yet.</p>}
      </div>
    </div>
  );
}
