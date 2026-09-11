import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import type { EnvironmentRecord } from "@ts-playwright/shared";
import { api } from "../api";

interface Reachability {
  reachable: boolean;
  status?: number;
  latency_ms: number;
  error?: string;
  checked_at: string;
}

// Environments of a project + the "test availability" probe the user asked for. Each row pings its
// own base_url on demand and shows a live reachable/unreachable verdict with latency/status.
export function ProjectEnvironmentsPanel({ projectId }: { projectId: string }) {
  const envs = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<EnvironmentRecord[]>(`/api/projects/${projectId}/environments`)
  });

  const [results, setResults] = useState<Record<string, Reachability | "checking">>({});

  const check = async (envId: string) => {
    setResults((r) => ({ ...r, [envId]: "checking" }));
    try {
      const res = await api.post<Reachability>(`/api/environments/${encodeURIComponent(envId)}/reachability`);
      setResults((r) => ({ ...r, [envId]: res }));
    } catch (e) {
      setResults((r) => ({
        ...r,
        [envId]: { reachable: false, latency_ms: 0, error: e instanceof Error ? e.message : String(e), checked_at: "" }
      }));
    }
  };

  const verdict = (envId: string) => {
    const r = results[envId];
    if (!r) return null;
    if (r === "checking") {
      return <span className="tsp-badge" data-status="running">checking…</span>;
    }
    if (r.reachable) {
      return (
        <span className="tsp-badge" data-status="passed">
          reachable · {r.status ?? "?"} · {r.latency_ms}ms
        </span>
      );
    }
    return (
      <span className="tsp-badge" data-status="failed" title={r.error}>
        unreachable{r.error ? ` · ${r.error}` : ""}
      </span>
    );
  };

  return (
    <div className="tsp-card" style={{ display: "grid", gap: 8, maxWidth: 560, marginBottom: 24 }}>
      <strong>Environments</strong>
      {envs.isLoading && <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading…</p>}
      {envs.error && <p style={{ color: "var(--status-failed)", margin: 0 }}>{String(envs.error)}</p>}
      {(envs.data ?? []).map((env) => (
        <div key={env.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{env.name}</strong>
            {env.is_default && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> · default</span>}
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 12,
                fontFamily: "var(--mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}
            >
              {env.base_url}
            </div>
          </div>
          {verdict(env.id)}
          <Button disabled={results[env.id] === "checking"} onClick={() => void check(env.id)}>
            Test availability
          </Button>
        </div>
      ))}
      {envs.data?.length === 0 && <p style={{ color: "var(--text-muted)", margin: 0 }}>No environments.</p>}
    </div>
  );
}
