import { useQuery } from "@tanstack/react-query";
import { Column, ErrorState, Spinner, Table } from "@ts-playwright/ui";
import { api } from "../api";
import { useT } from "../i18n";

interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actor_login: string | null;
  target: string | null;
}

const columns: Column<AuditEntry>[] = [
  { key: "at", header: "When", nowrap: true, muted: true, render: (e) => e.at.replace("T", " ").slice(0, 19) },
  { key: "action", header: "Action", render: (e) => <span style={{ fontFamily: "var(--mono)" }}>{e.action}</span> },
  { key: "actor", header: "Actor", render: (e) => e.actor_login ?? "—" },
  { key: "target", header: "Target", muted: true, render: (e) => e.target ?? "—" }
];

export function Audit() {
  const { t } = useT();
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntry[]>("/api/auth/audit?limit=200") });

  return (
    <div>
      <h1>{t("page.audit")}</h1>
      {audit.isLoading && <Spinner />}
      {audit.error && <ErrorState error={audit.error} />}
      <Table columns={columns} rows={audit.data ?? []} rowKey={(e) => e.id} empty="No audit entries yet." />
    </div>
  );
}
