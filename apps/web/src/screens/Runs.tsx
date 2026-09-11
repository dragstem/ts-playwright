import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, Spinner, StatusBadge } from "@ts-playwright/ui";
import type { RunRecord, ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { useRunsLive } from "../lib/useRunsLive";
import { useT } from "../i18n";
import { toastMessage, useToast } from "../components/Toast";

interface RecentRun {
  run: RunRecord;
  scenario?: ScenarioRecord;
  trace_id?: string;
  output_summary?: string;
}

interface RunsResponse {
  limit: number | null;
  runs: RecentRun[];
}

const STATUS_FILTERS = ["all", "running", "queued", "passed", "failed", "error"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

// The status a run reads as in the list: the finer outcome once finished, else the live status.
function effectiveStatus(run: RunRecord): string {
  return run.outcome ?? run.status;
}

function matchesStatus(run: RunRecord, filter: StatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "error") {
    // Group the error-ish terminal outcomes (error/timeout/interrupted) under one chip.
    return run.status === "error";
  }
  return run.status === filter || run.outcome === filter;
}

function isActive(run: RunRecord): boolean {
  return run.status === "queued" || run.status === "running";
}

// Recent runs across all projects — entry point into the live run page. Read-only list that
// refetches periodically; client-side status filter + text search narrow it without a round-trip.
export function Runs() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  // Live: refresh the moment a run starts/finishes (SSE); the poll is just a reconnect safety net.
  useRunsLive();
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<RunsResponse>("/api/runs?limit=100"),
    refetchInterval: 15000
  });

  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  // Filter by when the run finished. 0 = any; otherwise a window in hours from now.
  const [finishedWithin, setFinishedWithin] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopping, setStopping] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  // Bulk stop: fire the per-run stop for each selected active run, then refresh.
  const stopSelected = async (activeIds: string[]) => {
    setStopping(true);
    const results = await Promise.allSettled(activeIds.map((id) => api.post(`/api/runs/${id}/stop`, {})));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      toast.error(`Failed to stop ${failed} of ${activeIds.length} run(s)`);
    } else {
      toast.success(`Stopped ${activeIds.length} run(s)`);
    }
    setSelected(new Set());
    setStopping(false);
    qc.invalidateQueries({ queryKey: ["runs"] });
  };

  const all = runs.data?.runs ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const finishedCutoff = finishedWithin > 0 ? Date.now() - finishedWithin * 3600_000 : 0;
    return all.filter(({ run, scenario }) => {
      if (!matchesStatus(run, status)) {
        return false;
      }
      if (finishedCutoff) {
        // Keep only runs that finished within the window (unfinished runs have no finish time).
        if (!run.finished_at || Date.parse(run.finished_at) < finishedCutoff) {
          return false;
        }
      }
      if (!needle) {
        return true;
      }
      return (
        (scenario?.name ?? "").toLowerCase().includes(needle) ||
        run.scenario_id.toLowerCase().includes(needle) ||
        run.id.toLowerCase().includes(needle)
      );
    });
  }, [all, status, search, finishedWithin]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const { run } of all) {
      const key = effectiveStatus(run);
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [all]);

  return (
    <div>
      <h1>{t("page.runs")}</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        {STATUS_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            className="tsp-badge"
            data-status={value === "all" ? undefined : value}
            style={{
              cursor: "pointer",
              border: value === status ? "1px solid var(--text)" : "1px solid var(--border)",
              background: value === status ? "var(--surface-2, var(--surface))" : "transparent"
            }}
          >
            {value}
            {value !== "all" && counts[value] ? ` ${counts[value]}` : ""}
          </button>
        ))}
        <select
          value={finishedWithin}
          onChange={(e) => setFinishedWithin(Number(e.target.value))}
          title="Filter by when the run finished"
          style={{ marginLeft: "auto" }}
        >
          <option value={0}>Finished: any time</option>
          <option value={1}>Finished: last hour</option>
          <option value={24}>Finished: last 24 hours</option>
          <option value={168}>Finished: last 7 days</option>
          <option value={720}>Finished: last 30 days</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by scenario or id…"
          style={{ minWidth: 220 }}
        />
      </div>
      {selected.size > 0 && (
        <div
          className="tsp-card"
          style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}
        >
          <span style={{ flex: 1, color: "var(--text-muted)", fontSize: 13 }}>{selected.size} selected</span>
          {(() => {
            const activeIds = filtered.filter(({ run }) => selected.has(run.id) && isActive(run)).map(({ run }) => run.id);
            return (
              <Button
                variant="danger"
                disabled={activeIds.length === 0 || stopping}
                onClick={() => void stopSelected(activeIds)}
              >
                Stop selected{activeIds.length ? ` (${activeIds.length})` : ""}
              </Button>
            );
          })()}
          <Button variant="secondary" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {runs.isLoading && <Spinner />}
      {runs.error && <ErrorState error={runs.error} />}
      <div style={{ display: "grid", gap: 8 }}>
        {filtered.map(({ run, scenario }) => (
          <div
            key={run.id}
            className="tsp-card"
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <input
              type="checkbox"
              checked={selected.has(run.id)}
              onChange={() => toggle(run.id)}
              title="Select"
            />
            <Link
              to={`/runs/${run.id}`}
              style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--text)", flex: 1, textDecoration: "none" }}
            >
            <StatusBadge status={run.outcome ?? run.status} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>📄 {scenario?.name ?? run.scenario_id}</strong>
              {scenario?.folder_path ? (
                <div style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>📁 {scenario.folder_path}</div>
              ) : null}
            </span>
            {run.run_iteration > 1 || run.amount_times_to_run > 1 ? (
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                #{run.run_iteration}/{run.amount_times_to_run}
              </span>
            ) : null}
            <span
              style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}
              title={run.finished_at ? "Finished" : "Triggered"}
            >
              {(run.finished_at ?? run.triggered_at)?.slice(0, 19).replace("T", " ")}
            </span>
            <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{run.id.slice(0, 8)}</code>
            </Link>
            {run.batch_id ? (
              <Link to={`/batches/${run.batch_id}`} style={{ color: "var(--text-muted)", fontSize: 12 }}>
                batch
              </Link>
            ) : null}
          </div>
        ))}
        {!runs.isLoading && filtered.length === 0 && (
          <EmptyState>{all.length === 0 ? "No runs yet." : "No runs match the filter."}</EmptyState>
        )}
      </div>
    </div>
  );
}
