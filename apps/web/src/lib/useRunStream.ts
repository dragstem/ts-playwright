import { useEffect, useState } from "react";

interface PhaseTiming {
  started_at: string;
  duration_ms: number | null;
  status: string;
}

export interface RunStreamState {
  status?: string;
  phase?: string;
  outcome?: string | null;
  phaseTimings: Record<string, PhaseTiming>;
  log: { timestamp: string; level: string; message: string }[];
  connected: boolean;
}

// Subscribe to GET /api/runs/:id/stream (SSE): apply the snapshot, then run.phase/log/status
// deltas. Replaces polling + reload as the live source for the run page.
export function useRunStream(runId: string | undefined): RunStreamState {
  const [state, setState] = useState<RunStreamState>({ phaseTimings: {}, log: [], connected: false });

  useEffect(() => {
    if (!runId) {
      return;
    }
    setState({ phaseTimings: {}, log: [], connected: false });
    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`, { withCredentials: true });
    const parse = (e: Event) => JSON.parse((e as MessageEvent).data);

    es.addEventListener("run.snapshot", (e) => {
      const d = parse(e);
      setState({
        status: d.status,
        phase: d.phase,
        outcome: d.outcome ?? null,
        phaseTimings: d.phase_timings ?? {},
        log: d.log_entries ?? [],
        connected: true
      });
    });
    es.addEventListener("run.phase", (e) => {
      const d = parse(e);
      setState((s) => ({ ...s, phase: d.phase, phaseTimings: d.phase_timings ?? s.phaseTimings }));
    });
    es.addEventListener("run.log", (e) => {
      const entry = parse(e);
      setState((s) => ({ ...s, log: [...s.log, entry].slice(-1000) }));
    });
    es.addEventListener("run.status", (e) => {
      const d = parse(e);
      setState((s) => ({ ...s, status: d.status, outcome: d.outcome ?? s.outcome, phase: d.phase ?? s.phase }));
    });
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));

    return () => es.close();
  }, [runId]);

  return state;
}
