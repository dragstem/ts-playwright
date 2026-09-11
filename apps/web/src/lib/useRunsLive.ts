import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Keep the run/batch LIST queries fresh from the execution SSE instead of a tight poll. The execution
// stream emits execution.active whenever a run starts or finishes (the active count changes), which is
// exactly when a list's content meaningfully changes — so we invalidate ["runs"] and ["batches"] and the
// just-finished outcome shows within ~a second. Screens keep only a slow refetchInterval as a reconnect
// safety net. Mirrors useBatchStream's per-hook EventSource; React Query dedupes the resulting refetches.
export function useRunsLive(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const es = new EventSource("/api/stream/execution", { withCredentials: true });
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["batches"] });
    };
    // execution.active: a run started/finished. execution.snapshot: (re)connected — resync once.
    es.addEventListener("execution.active", refresh);
    es.addEventListener("execution.snapshot", refresh);
    return () => es.close();
  }, [enabled, qc]);
}
