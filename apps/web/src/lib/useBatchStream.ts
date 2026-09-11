import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Subscribe to GET /api/batches/:id/stream (SSE) and push each batch.snapshot / batch.aggregate into
// the ["batch", id] query cache, so the detail view updates live instead of polling. The query still
// owns the initial fetch and mutation invalidation; this just replaces the refetch interval.
export function useBatchStream(batchId: string | undefined, enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !batchId) {
      return;
    }
    const es = new EventSource(`/api/batches/${encodeURIComponent(batchId)}/stream`, { withCredentials: true });
    const apply = (e: Event) => {
      try {
        qc.setQueryData(["batch", batchId], JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frames
      }
    };
    es.addEventListener("batch.snapshot", apply);
    es.addEventListener("batch.aggregate", apply);
    return () => es.close();
  }, [batchId, enabled, qc]);
}
