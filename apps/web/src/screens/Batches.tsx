import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Spinner, StatusBadge } from "@ts-playwright/ui";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useBatchStream } from "../lib/useBatchStream";
import { useRunsLive } from "../lib/useRunsLive";
import { useConcurrency } from "../lib/useConcurrency";
import { useT } from "../i18n";

// Global execution setting: how many runner containers run at once (GET/PUT /api/settings).
function ConcurrencyControl() {
  const toast = useToast();
  const { current, save } = useConcurrency();
  const [value, setValue] = useState<number | null>(null);
  const shown = value ?? current;
  return (
    <div className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, maxWidth: 360 }}>
      <span style={{ fontSize: 13, color: "var(--text-muted)", flex: 1 }}>Max concurrent containers</span>
      <input
        type="number"
        min={1}
        value={shown}
        onChange={(e) => setValue(Math.max(1, Number(e.target.value) || 1))}
        style={{ width: 70 }}
      />
      <Button
        variant="primary"
        disabled={save.isPending}
        onClick={() =>
          save.mutate(shown, {
            onSuccess: (data) => {
              setValue(null);
              toast.success(`Max concurrent runs: ${data.max_concurrent_runs}`);
            },
            onError: (e) => toast.error(toastMessage(e))
          })
        }
      >
        Save
      </Button>
    </div>
  );
}

interface BatchRunSummary {
  id: string;
  scenario_id: string;
  scenario_name: string | null;
  status: string;
  outcome: string | null;
  execution_stage: number;
  run_iteration: number;
  amount_times_to_run: number;
  triggered_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface BatchSummary {
  batch_id: string;
  project_id: string | null;
  total: number;
  done: number;
  in_progress: boolean;
  status: string;
  counts: Record<string, number>;
  outcomes: Record<string, number>;
  scenario_ids: string[];
  stages: number[];
  triggered_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  runs: BatchRunSummary[];
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// The most meaningful timestamp for a run: when it finished, else when it started, else triggered.
function runDate(run: { finished_at: string | null; started_at: string | null; triggered_at: string }): string {
  const stamp = run.finished_at ?? run.started_at ?? run.triggered_at;
  return stamp ? stamp.slice(0, 19).replace("T", " ") : "—";
}

// Inline "what will be inserted" for one member run — its resolved inputs, fetched on demand.
function RunInputsInline({ runId }: { runId: string }) {
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<{ inputs: Record<string, string> }>(`/api/runs/${runId}`)
  });
  if (detail.isLoading) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 12px" }}>Loading…</div>;
  }
  const entries = Object.entries(detail.data?.inputs ?? {});
  return (
    <div style={{ display: "grid", gap: 2, padding: "6px 12px", borderTop: "1px solid var(--border)" }}>
      {entries.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No declared inputs.</span>}
      {entries.map(([name, value]) => (
        <div key={name} style={{ display: "flex", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)", minWidth: 140 }}>{name}</span>
          <code style={{ wordBreak: "break-word" }}>{value || "—"}</code>
        </div>
      ))}
    </div>
  );
}

function countsLabel(counts: Record<string, number>): string {
  return (["passed", "failed", "error", "running", "queued"] as const)
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

// Batch list — runs grouped by batch_id (repeated single-scenario run or folder/stage run), with
// an aggregate status and progress. Refetches so in-flight batches stay roughly current.
export function Batches() {
  const { t } = useT();
  // Live: refresh the moment a run starts/finishes (SSE); the poll is just a reconnect safety net.
  useRunsLive();
  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.get<{ batches: BatchSummary[] }>("/api/batches?limit=100"),
    refetchInterval: 15000
  });

  return (
    <div>
      <h1>{t("page.batches")}</h1>
      <ConcurrencyControl />
      {batches.isLoading && <Spinner />}
      {batches.error && <ErrorState error={batches.error} />}
      <div style={{ display: "grid", gap: 8 }}>
        {(batches.data?.batches ?? []).map((batch) => (
          <Link
            key={batch.batch_id}
            to={`/batches/${batch.batch_id}`}
            className="tsp-card"
            style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--text)" }}
          >
            <StatusBadge status={batch.status} />
            <strong style={{ flex: 1 }}>
              {batch.done}/{batch.total} · {countsLabel(batch.counts) || "—"}
            </strong>
            <span style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
              {batch.triggered_at?.slice(0, 19).replace("T", " ")}
            </span>
            <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{shortId(batch.batch_id)}</code>
          </Link>
        ))}
        {batches.data?.batches.length === 0 && <EmptyState>No batches yet.</EmptyState>}
      </div>
    </div>
  );
}

// Batch detail — aggregate header + the member runs, each linking to its live run page.
export function BatchDetail() {
  const { batchId } = useParams<{ batchId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const batch = useQuery({
    queryKey: ["batch", batchId],
    enabled: Boolean(batchId),
    queryFn: () => api.get<BatchSummary>(`/api/batches/${encodeURIComponent(batchId ?? "")}`),
    // The SSE stream drives live updates; keep a slow poll only as a reconnect safety net.
    refetchInterval: (query) => (query.state.data?.in_progress ? 15000 : false)
  });
  // Live batch aggregate over SSE (batch.snapshot + batch.aggregate → query cache).
  useBatchStream(batchId, Boolean(batchId));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["batch", batchId] });
    qc.invalidateQueries({ queryKey: ["batches"] });
  };
  const stop = useMutation({
    mutationFn: () => api.post(`/api/batches/${encodeURIComponent(batchId ?? "")}/stop`, {}),
    onSuccess: invalidate,
    onError: (e) => toast.error(toastMessage(e))
  });
  const retryFailed = useMutation({
    mutationFn: () => api.post(`/api/batches/${encodeURIComponent(batchId ?? "")}/retry-failed`, {}),
    onSuccess: invalidate,
    onError: (e) => toast.error(toastMessage(e))
  });
  const complete = useMutation({
    mutationFn: () => api.post(`/api/batches/${encodeURIComponent(batchId ?? "")}/complete`, {}),
    onSuccess: invalidate,
    onError: (e) => toast.error(toastMessage(e))
  });
  const [filter, setFilter] = useState("all");
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const toggleRun = (id: string) =>
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (batch.isLoading) {
    return <Spinner />;
  }
  if (batch.error || !batch.data) {
    return batch.error ? <ErrorState error={batch.error} /> : <EmptyState>Batch not found</EmptyState>;
  }
  const data = batch.data;

  return (
    <div>
      <Link to="/batches" style={{ color: "var(--text-muted)", fontSize: 12 }}>
        ← Batches
      </Link>
      <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <StatusBadge status={data.status} />
        <span>Batch {shortId(data.batch_id)}</span>
      </h1>
      <p style={{ color: "var(--text-muted)" }}>
        {data.done}/{data.total} done · {countsLabel(data.counts) || "—"}
        {data.stages.length > 1 ? ` · ${data.stages.length} stages` : ""}
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          variant="danger"
          disabled={!data.in_progress || stop.isPending}
          onClick={() => stop.mutate()}
        >
          Stop remaining
        </Button>
        <Button
          variant="secondary"
          disabled={(data.counts.failed ?? 0) + (data.counts.error ?? 0) === 0 || retryFailed.isPending}
          onClick={() => retryFailed.mutate()}
        >
          Retry failed
        </Button>
        <Button
          variant="secondary"
          disabled={data.in_progress || (data.counts.passed ?? 0) >= data.total || complete.isPending}
          onClick={() => complete.mutate()}
          title="Queue runs until every scenario reaches its target number of passes"
        >
          Complete
        </Button>
      </div>
      {/* Filter member runs by status/outcome */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 16 }}>
        {["all", "passed", "failed", "error", "running", "queued", "stopped"]
          .filter((f) => f === "all" || (data.counts[f] ?? 0) > 0)
          .map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="tsp-badge"
              data-status={f === "all" ? undefined : f}
              style={{
                cursor: "pointer",
                border: f === filter ? "1px solid var(--text)" : "1px solid var(--border)",
                background: "transparent"
              }}
            >
              {f}
              {f !== "all" && data.counts[f] ? ` ${data.counts[f]}` : ""}
            </button>
          ))}
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {data.runs
          .filter((run) => filter === "all" || (run.outcome ?? run.status) === filter)
          .map((run) => (
            <div key={run.id} className="tsp-card" style={{ padding: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
                <Link
                  to={`/runs/${run.id}`}
                  style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--text)", flex: 1, textDecoration: "none" }}
                >
                  <StatusBadge status={run.outcome ?? run.status} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>📄 {run.scenario_name ?? run.scenario_id}</strong>
                    {run.amount_times_to_run > 1 ? (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}> · #{run.run_iteration}/{run.amount_times_to_run}</span>
                    ) : null}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }} title="Finished / started / triggered">
                    {runDate(run)}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>stage {run.execution_stage}</span>
                  <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{shortId(run.id)}</code>
                </Link>
                <button
                  type="button"
                  onClick={() => toggleRun(run.id)}
                  title="Show the inputs that will be inserted for this attempt"
                  style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}
                >
                  {expandedRuns.has(run.id) ? "Hide inputs" : "Inputs"}
                </button>
              </div>
              {expandedRuns.has(run.id) && <RunInputsInline runId={run.id} />}
            </div>
          ))}
      </div>
    </div>
  );
}
