import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { StatusBadge } from "@ts-playwright/ui";
import type { ProjectRecord, RunRecord, ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { useRunsLive } from "../lib/useRunsLive";
import { useT } from "../i18n";

interface RecentRun {
  run: RunRecord;
  scenario?: ScenarioRecord;
}
interface RunsResponse {
  runs: RecentRun[];
}

function Stat({ label, value, status }: { label: string; value: number; status?: string }) {
  return (
    <div className="tsp-card" style={{ flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: status ? `var(--status-${status})` : "var(--text)" }}>
        {value}
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{label}</div>
    </div>
  );
}

// At-a-glance landing: live run activity + recent failures. Refetches so counts stay current.
export function Dashboard() {
  const { t } = useT();
  // Live: refresh the moment a run starts/finishes (SSE); the poll is just a reconnect safety net.
  useRunsLive();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectRecord[]>("/api/projects") });
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<RunsResponse>("/api/runs?limit=100"),
    refetchInterval: 15000
  });

  const all = (runs.data?.runs ?? []).map((r) => r.run);
  const active = all.filter((r) => r.status === "running" || r.status === "queued").length;
  const passed = all.filter((r) => r.status === "passed").length;
  const failed = all.filter((r) => r.status === "failed" || r.status === "error").length;
  const failures = (runs.data?.runs ?? [])
    .filter((r) => r.run.status === "failed" || r.run.status === "error")
    .slice(0, 8);

  return (
    <div>
      <h1>{t("dashboard.title")}</h1>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
        <Stat label={t("dashboard.projects")} value={projects.data?.length ?? 0} />
        <Stat label={t("dashboard.activeRuns")} value={active} status="running" />
        <Stat label={t("dashboard.passed")} value={passed} status="passed" />
        <Stat label={t("dashboard.failed")} value={failed} status="failed" />
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <section style={{ flex: 1, minWidth: 280 }}>
          <h3>{t("dashboard.projects")}</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {(projects.data ?? []).map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="tsp-card" style={{ color: "var(--text)" }}>
                <strong>{p.name}</strong>
              </Link>
            ))}
            {projects.data?.length === 0 && <p style={{ color: "var(--text-muted)" }}>No projects.</p>}
          </div>
        </section>

        <section style={{ flex: 1, minWidth: 280 }}>
          <h3>{t("dashboard.recentFailures")}</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {failures.map(({ run, scenario }) => (
              <Link
                key={run.id}
                to={`/runs/${run.id}`}
                className="tsp-card"
                style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)" }}
              >
                <StatusBadge status={run.outcome ?? run.status} />
                <span style={{ flex: 1 }}>{scenario?.name ?? run.scenario_id}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                  {run.triggered_at?.slice(0, 19).replace("T", " ")}
                </span>
              </Link>
            ))}
            {failures.length === 0 && <p style={{ color: "var(--text-muted)" }}>{t("dashboard.noFailures")}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
