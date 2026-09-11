import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, StatusBadge } from "@ts-playwright/ui";
import { api } from "../api";
import { useRunStream } from "../lib/useRunStream";
import { toastMessage, useToast } from "../components/Toast";
import { PhaseTimeline } from "../components/PhaseTimeline";

const PHASES = ["queued", "prepare", "pull_image", "create_container", "execute", "collecting", "done"];
const TERMINAL = new Set(["passed", "failed", "error"]);

// The settings a run was launched with. Secrets (server_password / server_2faotp) are shown as a
// set/unset flag only — the run snapshot stores their plaintext, which must never reach the UI.
interface RunDetail {
  scenario_id: string;
  env_id: string | null;
  account_login: string | null;
  merchant_name: string | null;
  server_username: string | null;
  server_password: string | null;
  server_2faotp: string | null;
  server_merchant: string | null;
  triggered_by: string;
  triggered_at: string;
  retry_of_run_id: string | null;
  batch_id: string | null;
  execution_stage: number;
  amount_times_to_run: number;
  run_iteration: number;
  default_timeout_ms: number | null;
  inputs: Record<string, string>;
}

export function RunLive() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const run = useRunStream(runId);
  const detail = useQuery({
    queryKey: ["run", runId],
    enabled: Boolean(runId),
    queryFn: () => api.get<RunDetail>(`/api/runs/${runId}`)
  });
  const [retrying, setRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const isTerminal = run.outcome != null || TERMINAL.has(run.status ?? "");
  const badge = run.outcome ?? run.status ?? "queued";

  // Artifacts (video/trace/screenshots) and extracted outputs appear as the run progresses; refetch
  // while it is still running, then stop.
  const artifacts = useQuery({
    queryKey: ["run-artifacts", runId],
    enabled: Boolean(runId),
    queryFn: () => api.get<{ artifacts: string[] }>(`/api/runs/${runId}/artifacts`).catch(() => ({ artifacts: [] })),
    refetchInterval: isTerminal ? false : 4000
  });
  const outputs = useQuery({
    queryKey: ["run-outputs", runId],
    enabled: Boolean(runId),
    queryFn: () => api.get<{ outputs: Record<string, unknown> }>(`/api/runs/${runId}/outputs`).catch(() => ({ outputs: {} })),
    refetchInterval: isTerminal ? false : 4000
  });
  // Resolve the scenario so the run shows a human name (and folder), not just ids.
  const scenario = useQuery({
    queryKey: ["scenario", detail.data?.scenario_id],
    enabled: Boolean(detail.data?.scenario_id),
    queryFn: () => api.get<{ name: string; folder_path: string }>(`/api/scenarios/${detail.data?.scenario_id}`)
  });

  // Cancel an in-flight run (backend kills the container; the run finalizes as outcome=stopped).
  const stop = async () => {
    if (!runId) return;
    setStopping(true);
    try {
      await api.post(`/api/runs/${runId}/stop`, {});
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setStopping(false);
    }
  };

  // Re-run the same scenario with the same inputs (backend clones this run as triggered_by=retry)
  // and follow the new run live — the "repeatable" half of every flow.
  const retry = async () => {
    if (!runId) return;
    setRetrying(true);
    try {
      const next = await api.post<{ id: string }>(`/api/runs/${runId}/retry`, {});
      navigate(`/runs/${next.id}`);
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div>
      <Link to="..">← Back</Link>
      <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>📄 {scenario.data?.name ?? "Run"}</span>
        <StatusBadge status={badge} />
        <span style={{ fontSize: 12, color: run.connected ? "var(--status-passed)" : "var(--text-muted)" }}>
          {run.connected ? "● live" : "○ offline"}
        </span>
        {isTerminal ? (
          <Button variant="primary" disabled={retrying} onClick={() => void retry()}>
            {retrying ? "…" : "↻ Retry"}
          </Button>
        ) : (
          <Button variant="danger" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "…" : "■ Stop"}
          </Button>
        )}
      </h1>
      <div style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)", marginTop: -8, marginBottom: 8 }}>
        {scenario.data?.folder_path ? `📁 ${scenario.data.folder_path} · ` : ""}run {runId}
      </div>

      <PhaseTimeline phases={PHASES} timings={run.phaseTimings} currentPhase={run.phase} isTerminal={isTerminal} />

      {runId && <RunArtifacts runId={runId} files={artifacts.data?.artifacts ?? []} />}
      <RunOutputs outputs={outputs.data?.outputs ?? {}} />
      {detail.data && <RunSettings detail={detail.data} scenarioName={scenario.data?.name} />}

      <h3>Console</h3>
      <pre
        className="tsp-card"
        style={{ maxHeight: 360, overflow: "auto", fontSize: 12, fontFamily: "var(--mono)", whiteSpace: "pre-wrap" }}
      >
        {run.log.map((l) => `${l.timestamp.slice(11, 19)}  [${l.level}] ${l.message}`).join("\n") ||
          "(no output yet)"}
      </pre>
    </div>
  );
}

const VIDEO_RE = /\.(webm|mp4)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg)$/i;

// Run artifacts: video of the attempt, screenshots, trace, logs. Media renders inline; everything
// else is a download link. Files are served from /api/runs/:id/artifacts/<path> (cookie-authed).
function RunArtifacts({ runId, files }: { runId: string; files: string[] }) {
  if (files.length === 0) {
    return null;
  }
  const url = (file: string) => `/api/runs/${runId}/artifacts/${file.split("/").map(encodeURIComponent).join("/")}`;
  const videos = files.filter((f) => VIDEO_RE.test(f));
  const images = files.filter((f) => IMAGE_RE.test(f));
  return (
    <div className="tsp-card" style={{ display: "grid", gap: 10, marginTop: 12 }}>
      <strong>Artifacts</strong>
      {videos.map((file) => (
        <div key={file} style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>🎬 {file}</span>
          <video src={url(file)} controls style={{ maxWidth: "100%", borderRadius: 6, background: "#000" }} />
        </div>
      ))}
      {images.map((file) => (
        <div key={file} style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>🖼 {file}</span>
          <img src={url(file)} alt={file} style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
        </div>
      ))}
      <div style={{ display: "grid", gap: 2 }}>
        {files.map((file) => (
          <a key={file} href={url(file)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            📎 {file}
          </a>
        ))}
      </div>
    </div>
  );
}

function RunOutputs({ outputs }: { outputs: Record<string, unknown> }) {
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="tsp-card" style={{ display: "grid", gap: 6, marginTop: 12 }}>
      <strong>Outputs</strong>
      {entries.map(([key, value]) => (
        <Row key={key} label={key}>
          <code style={{ fontSize: 12, wordBreak: "break-word" }}>
            {typeof value === "string" ? value : JSON.stringify(value)}
          </code>
        </Row>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13 }}>
      <span style={{ color: "var(--text-muted)", minWidth: 150 }}>{label}</span>
      <span style={{ flex: 1, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

function secretBadge(value: string | null) {
  return (
    <span className="tsp-badge" data-status={value ? "passed" : "queued"}>
      {value ? "set" : "unset"}
    </span>
  );
}

// The configuration a run was launched with — the "с какими настройками он запустился" panel.
function RunSettings({ detail, scenarioName }: { detail: RunDetail; scenarioName?: string }) {
  const inputEntries = Object.entries(detail.inputs ?? {});
  return (
    <div className="tsp-card" style={{ display: "grid", gap: 6, marginTop: 12 }}>
      <strong>Launch settings</strong>
      <Row label="Scenario">
        {scenarioName ? `${scenarioName} · ` : ""}
        <code style={{ fontSize: 12 }}>{detail.scenario_id}</code>
      </Row>
      <Row label="Environment">{detail.env_id ?? "—"}</Row>
      <Row label="Stand account">{detail.account_login ?? "—"}</Row>
      <Row label="Merchant">{detail.merchant_name ?? "—"}</Row>
      <Row label="server_username">{detail.server_username || "—"}</Row>
      <Row label="server_password">{secretBadge(detail.server_password)}</Row>
      <Row label="server_2faotp">{secretBadge(detail.server_2faotp)}</Row>
      <Row label="server_merchant">{detail.server_merchant || "—"}</Row>
      <Row label="Run">
        #{detail.run_iteration}/{detail.amount_times_to_run} · stage {detail.execution_stage}
      </Row>
      <Row label="Timeout">{detail.default_timeout_ms ? `${detail.default_timeout_ms} ms` : "default"}</Row>
      <Row label="Triggered by">
        {detail.triggered_by} · {detail.triggered_at.replace("T", " ").slice(0, 19)}
      </Row>
      {detail.retry_of_run_id && (
        <Row label="Retry of">
          <Link to={`/runs/${detail.retry_of_run_id}`}>
            <code style={{ fontSize: 12 }}>{detail.retry_of_run_id.slice(0, 8)}</code>
          </Link>
        </Row>
      )}
      {detail.batch_id && (
        <Row label="Batch">
          <Link to={`/batches/${detail.batch_id}`}>
            <code style={{ fontSize: 12 }}>{detail.batch_id.slice(0, 8)}</code>
          </Link>
        </Row>
      )}
      {inputEntries.length > 0 && (
        <>
          <strong style={{ marginTop: 4, fontSize: 13, color: "var(--text-muted)" }}>Inputs</strong>
          {inputEntries.map(([name, value]) => (
            <Row key={name} label={name}>
              <code style={{ fontSize: 12 }}>{value || "—"}</code>
            </Row>
          ))}
        </>
      )}
    </div>
  );
}
