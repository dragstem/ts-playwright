import { useEffect, useState } from "react";

export interface ExecutionStreamState {
  active: number;
  connected: boolean;
}

// Subscribe to GET /api/stream/execution (SSE): a snapshot of currently active runs on connect,
// then execution.active deltas as runs start/finish. Powers the header running-counter without
// per-run polling. Stays silent (active 0, disconnected) until the first frame arrives.
export function useExecutionStream(enabled: boolean): ExecutionStreamState {
  const [state, setState] = useState<ExecutionStreamState>({ active: 0, connected: false });

  useEffect(() => {
    if (!enabled) {
      setState({ active: 0, connected: false });
      return;
    }
    const es = new EventSource("/api/stream/execution", { withCredentials: true });
    const readActive = (e: Event) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { active?: number };
        if (typeof d.active === "number") {
          setState({ active: d.active, connected: true });
        }
      } catch {
        // ignore malformed frames
      }
    };
    es.addEventListener("execution.snapshot", readActive);
    es.addEventListener("execution.active", readActive);
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    return () => es.close();
  }, [enabled]);

  return state;
}
