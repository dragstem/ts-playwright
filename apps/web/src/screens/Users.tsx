import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Column, ErrorState, Spinner, Table } from "@ts-playwright/ui";
import type { PublicUser } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useT } from "../i18n";

const ROLES = ["admin", "operator", "viewer"];

export function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useT();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<PublicUser[]>("/api/auth/users") });

  const patch = useMutation({
    mutationFn: (vars: { id: string; body: Record<string, string> }) =>
      api.patch(`/api/auth/users/${vars.id}`, vars.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: (e) => toast.error(toastMessage(e))
  });

  const columns: Column<PublicUser>[] = [
    { key: "login", header: "Login", render: (u) => u.login },
    {
      key: "role",
      header: "Role",
      render: (u) => (
        <select value={u.role} onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value } })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )
    },
    {
      key: "status",
      header: "Status",
      render: (u) => (
        <button
          className="tsp-btn"
          onClick={() => patch.mutate({ id: u.id, body: { status: u.status === "active" ? "disabled" : "active" } })}
        >
          {u.status}
        </button>
      )
    },
    {
      key: "mfa",
      header: "2FA",
      render: (u) => (
        <span className="tsp-badge" data-status={u.mfa_enabled ? "passed" : "queued"}>
          {u.mfa_enabled ? "on" : "off"}
        </span>
      )
    },
    { key: "last_login", header: "Last login", muted: true, nowrap: true, render: (u) => u.last_login_at ?? "—" }
  ];

  return (
    <div>
      <h1>{t("page.users")}</h1>
      {users.isLoading && <Spinner />}
      {users.error && <ErrorState error={users.error} />}
      <Table columns={columns} rows={users.data ?? []} rowKey={(u) => u.id} empty="No users yet." />
    </div>
  );
}
