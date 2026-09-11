import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { MfaPanel } from "../components/MfaPanel";
import { useT } from "../i18n";

interface PublicToken {
  id: string;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
}

// Personal access tokens for the desktop agent. The plaintext token is shown exactly once,
// right after creation — afterwards only the label/scope/usage metadata is listed.
export function Tokens() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<PublicToken[]>("/api/auth/tokens") });

  const [label, setLabel] = useState("");
  const [freshToken, setFreshToken] = useState("");

  const create = useMutation({
    mutationFn: () => api.post<{ token: string } & PublicToken>("/api/auth/tokens", { label: label.trim() }),
    onSuccess: (r) => {
      setFreshToken(r.token);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/auth/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] })
  });

  const copyFreshToken = async () => {
    try {
      await copyText(freshToken);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy the token. Select it and copy manually.");
    }
  };

  return (
    <div>
      <h1>{t("page.tokens")}</h1>
      <MfaPanel />
      <p style={{ color: "var(--text-muted)" }}>
        Bearer tokens for the desktop agent. Treat them like passwords — a token is shown once and cannot be recovered.
      </p>

      <div className="tsp-card" style={{ display: "flex", gap: 8, maxWidth: 520, marginBottom: 16 }}>
        <input
          style={{ flex: 1 }}
          placeholder="label (e.g. my-laptop agent)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>

      {freshToken && (
        <div className="tsp-card" style={{ marginBottom: 16, display: "grid", gap: 8 }}>
          <strong style={{ color: "var(--status-passed)" }}>New token — copy it now, it won't be shown again:</strong>
          <code style={{ fontFamily: "var(--mono)", wordBreak: "break-all", userSelect: "all" }}>{freshToken}</code>
          <div>
            <Button onClick={() => void copyFreshToken()}>Copy</Button>{" "}
            <Button onClick={() => setFreshToken("")}>Dismiss</Button>
          </div>
        </div>
      )}

      {tokens.isLoading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {(tokens.data ?? []).map((t) => (
          <div key={t.id} className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <strong style={{ flex: 1 }}>{t.label || "(unnamed)"}</strong>
            <span className="tsp-badge" data-status="queued">
              {t.scope}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {t.last_used_at ? `used ${t.last_used_at.slice(0, 19).replace("T", " ")}` : "never used"}
            </span>
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm({ message: `Revoke token "${t.label || t.id}"? Any agent using it will lose access.`, confirmLabel: "Revoke", danger: true })) {
                  revoke.mutate(t.id);
                }
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
        {tokens.data?.length === 0 && <p style={{ color: "var(--text-muted)" }}>No tokens yet.</p>}
      </div>
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // HTTP connections do not expose Clipboard API permissions in many browsers.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}
