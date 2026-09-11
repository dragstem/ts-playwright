import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import type { MerchantRecord, ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { ScopeLegend } from "../components/ScopeLegend";
import { useT } from "../i18n";

interface MaskedAccount {
  login: string;
}

// Merchants (the {server_merchant} values), optionally bound to an admin stand account. No secrets
// live here, so records are shown in full. admin_login must reference an existing stand credential.
export function Merchants() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const merchants = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<MerchantRecord[]>("/api/merchants") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<MaskedAccount[]>("/api/accounts") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectRecord[]>("/api/projects") });
  const projectName = (id: string | null) =>
    id ? projects.data?.find((p) => p.id === id)?.name ?? id : "global";

  const [name, setName] = useState("");
  const [adminLogin, setAdminLogin] = useState("");
  const [envIds, setEnvIds] = useState("");
  const [scope, setScope] = useState(""); // "" = global, else project_id

  const save = useMutation({
    mutationFn: () =>
      api.post("/api/merchants", {
        name: name.trim(),
        admin_login: adminLogin.trim() || null,
        project_id: scope || null,
        env_ids: envIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      }),
    onSuccess: () => {
      setName("");
      setAdminLogin("");
      setEnvIds("");
      qc.invalidateQueries({ queryKey: ["merchants"] });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const del = useMutation({
    mutationFn: (m: MerchantRecord) =>
      api.del(`/api/merchants/${encodeURIComponent(m.name)}?project_id=${encodeURIComponent(m.project_id ?? "")}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["merchants"] })
  });

  return (
    <div>
      <h1>{t("page.merchants")}</h1>
      <p style={{ color: "var(--text-muted)" }}>
        {"{server_merchant}"} values, optionally bound to an admin stand account.
      </p>
      <ScopeLegend />

      <div className="tsp-card" style={{ display: "grid", gap: 8, maxWidth: 480, marginBottom: 16 }}>
        <input placeholder={t("form.merchant_name")} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          list="account-logins"
          placeholder="admin login (optional)"
          value={adminLogin}
          onChange={(e) => setAdminLogin(e.target.value)}
        />
        <datalist id="account-logins">
          {(accounts.data ?? []).map((a) => (
            <option key={a.login} value={a.login} />
          ))}
        </datalist>
        <input
          placeholder="env ids (comma-separated, optional)"
          value={envIds}
          onChange={(e) => setEnvIds(e.target.value)}
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
        <Button variant="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          {t("action.save")}
        </Button>
      </div>

      {merchants.isLoading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {(merchants.data ?? []).map((m) => (
          <div key={`${m.project_id ?? "global"}:${m.name}`} className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <strong style={{ flex: 1 }}>{m.name}</strong>
            <span className="tsp-badge" data-status={m.project_id ? "running" : "queued"}>
              {projectName(m.project_id)}
            </span>
            {m.admin_login && (
              <span className="tsp-badge" data-status="passed">
                admin: {m.admin_login}
              </span>
            )}
            {m.env_ids.length > 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{m.env_ids.join(", ")}</span>
            )}
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm({ message: `Delete merchant "${m.name}"?`, confirmLabel: t("action.delete"), danger: true })) {
                  del.mutate(m);
                }
              }}
            >
              {t("action.delete")}
            </Button>
          </div>
        ))}
        {merchants.data?.length === 0 && <p style={{ color: "var(--text-muted)" }}>No merchants yet.</p>}
      </div>
    </div>
  );
}
