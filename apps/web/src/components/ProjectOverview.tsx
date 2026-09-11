import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { StatusBadge } from "@ts-playwright/ui";
import type { RunRecord, ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { useRunsLive } from "../lib/useRunsLive";

interface RecentRun {
  run: RunRecord;
  scenario?: ScenarioRecord;
}
interface RunsResponse {
  runs: RecentRun[];
}

function Stat({ label, value, status }: { label: string; value: number; status?: string }) {
  return (
    <div className="tsp-card" style={{ flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: status ? `var(--status-${status})` : "var(--text)" }}>{value}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{label}</div>
    </div>
  );
}

// Per-project dashboard: this project's run activity + recent runs/failures. Runs carry no project_id
// but each /api/runs entry embeds its scenario (which does), so we filter client-side.
export function ProjectOverview({ projectId }: { projectId: string }) {
  // Live: refresh the moment a run starts/finishes (SSE); the poll is just a reconnect safety net.
  useRunsLive();
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<RunsResponse>("/api/runs?limit=100"),
    refetchInterval: 15000
  });

  const mine = (runs.data?.runs ?? []).filter((r) => r.scenario?.project_id === projectId);
  const active = mine.filter((r) => r.run.status === "running" || r.run.status === "queued").length;
  const passed = mine.filter((r) => r.run.status === "passed").length;
  const failed = mine.filter((r) => r.run.status === "failed" || r.run.status === "error").length;
  const recent = mine.slice(0, 10);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Stat label="Active runs" value={active} status="running" />
        <Stat label="Passed (recent)" value={passed} status="passed" />
        <Stat label="Failed (recent)" value={failed} status="failed" />
      </div>

      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ flex: 1, margin: 0 }}>Recent runs</h3>
          <Link to="/runs" style={{ fontSize: 12 }}>
            All runs →
          </Link>
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {recent.map(({ run, scenario }) => (
            <Link
              key={run.id}
              to={`/runs/${run.id}`}
              className="tsp-card"
              style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", textDecoration: "none" }}
            >
              <StatusBadge status={run.outcome ?? run.status} />
              <span style={{ flex: 1 }}>{scenario?.name ?? run.scenario_id}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                {run.triggered_at?.slice(0, 19).replace("T", " ")}
              </span>
            </Link>
          ))}
          {mine.length === 0 && (
            <p style={{ color: "var(--text-muted)" }}>
              No runs yet for this project. Open the <strong>Scenarios</strong> tab and run one, or record a new scenario with the desktop agent.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
