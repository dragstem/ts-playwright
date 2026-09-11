import { useEffect, useState } from "react";

export interface HealthStreamState {
  ready: boolean | null;
  checks: { storage?: boolean; docker?: boolean };
  connected: boolean;
}

// Subscribe to GET /api/stream/health (SSE): a readiness snapshot on connect, refreshed every 10s.
// Powers the header HealthIndicator. `ready` is null until the first frame; `connected` reflects the
// SSE link itself (a dropped stream is its own signal that something is wrong).
export function useHealthStream(enabled: boolean): HealthStreamState {
  const [state, setState] = useState<HealthStreamState>({ ready: null, checks: {}, connected: false });

  useEffect(() => {
    if (!enabled) {
      setState({ ready: null, checks: {}, connected: false });
      return;
    }
    const es = new EventSource("/api/stream/health", { withCredentials: true });
    es.addEventListener("health", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as {
          ready?: boolean;
          checks?: { storage?: boolean; docker?: boolean };
        };
        setState({ ready: Boolean(d.ready), checks: d.checks ?? {}, connected: true });
      } catch {
        // ignore malformed frames
      }
    });
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    return () => es.close();
  }, [enabled]);

  return state;
}
