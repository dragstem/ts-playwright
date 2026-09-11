import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, SecretField } from "@ts-playwright/ui";
import { api } from "../api";
import { toastMessage, useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";

interface MaskedServerVars {
  project_id: string;
  server_username: string;
  server_merchant: string;
  has_password: boolean;
  has_2faotp: boolean;
  extra: Record<string, string>;
  updated_at: string;
}

// Per-project {server_*} defaults - the multiproject foundation. Non-secret fields (username,
// merchant) are shown and editable; password/2FA are write-only (empty keeps the stored value),
// surfaced only as "configured" flags.
export function ProjectServerVarsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ["server-vars", projectId];
  const vars = useQuery({
    queryKey: key,
    enabled: Boolean(projectId),
    queryFn: () => api.get<MaskedServerVars>(`/api/projects/${projectId}/server-vars`)
  });

  const [username, setUsername] = useState("");
  const [merchant, setMerchant] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  // Phase 2 / 2-R10 - arbitrary extra {server_*} tokens (non-secret). Edited as key/value rows
  // and substituted into input values at run time alongside the four standard tokens.
  const [extraRows, setExtraRows] = useState<{ key: string; value: string }[]>([]);

  // Seed the editable text fields from the server once loaded (secrets stay empty = "keep").
  useEffect(() => {
    if (vars.data) {
      setUsername(vars.data.server_username);
      setMerchant(vars.data.server_merchant);
      setExtraRows(Object.entries(vars.data.extra).map(([key, value]) => ({ key, value })));
    }
  }, [vars.data?.server_username, vars.data?.server_merchant, vars.data?.updated_at]);

  const save = useMutation({
    mutationFn: () => {
      const extra: Record<string, string> = {};
      for (const row of extraRows) {
        const key = row.key.trim();
        if (key) {
          extra[key] = row.value;
        }
      }
      const body: Record<string, unknown> = {
        server_username: username.trim(),
        server_merchant: merchant.trim(),
        extra
      };
      if (password) body.server_password = password;
      if (otp) body.server_2faotp = otp;
      return api.post(`/api/projects/${projectId}/server-vars`, body);
    },
    onSuccess: () => {
      setPassword("");
      setOtp("");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const clear = useMutation({
    mutationFn: () => api.del(`/api/projects/${projectId}/server-vars`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key })
  });

  return (
    <div className="tsp-card" style={{ display: "grid", gap: 8, maxWidth: 480, marginBottom: 24 }}>
      <strong>Project server-vars</strong>
      <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
        Defaults for {"{server_*}"} placeholders, used when a run doesn't override them. Secrets are write-only.
      </p>
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>server_username</label>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="server_username" />
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>server_merchant</label>
      <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="server_merchant" />
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
        server_password{" "}
        <span className="tsp-badge" data-status={vars.data?.has_password ? "passed" : "queued"}>
          {vars.data?.has_password ? "set" : "unset"}
        </span>
      </label>
      <SecretField
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="leave empty to keep"
      />
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
        server_2faotp{" "}
        <span className="tsp-badge" data-status={vars.data?.has_2faotp ? "passed" : "queued"}>
          {vars.data?.has_2faotp ? "set" : "unset"}
        </span>
      </label>
      <SecretField value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="base32 secret, leave empty to keep" />
      <label style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        Extra variables - non-secret {"{name}"} tokens
      </label>
      {extraRows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: 8 }}>
          <input
            value={row.key}
            onChange={(e) =>
              setExtraRows((rows) => rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
            }
            placeholder="server_apikey"
            style={{ flex: 1 }}
          />
          <input
            value={row.value}
            onChange={(e) =>
              setExtraRows((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
            }
            placeholder="value"
            style={{ flex: 1 }}
          />
          <Button variant="secondary" onClick={() => setExtraRows((rows) => rows.filter((_, i) => i !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button variant="secondary" onClick={() => setExtraRows((rows) => [...rows, { key: "", value: "" }])}>
          + Add variable
        </Button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save defaults
        </Button>
        <Button
          variant="danger"
          disabled={clear.isPending}
          onClick={async () => {
            if (await confirm({ message: "Clear all project server-vars (including stored secrets)?", confirmLabel: "Clear", danger: true })) {
              clear.mutate();
            }
          }}
        >
          Clear all
        </Button>
      </div>
    </div>
  );
}
