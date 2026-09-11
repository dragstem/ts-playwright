import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface Settings {
  max_concurrent_runs: number;
}

// Global execution concurrency (max runner containers at once), backed by GET/PUT /api/settings.
// Shared by the Batches page control and the batch launch modal so they stay in sync.
export function useConcurrency() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const save = useMutation({
    mutationFn: (value: number) => api.put<Settings>("/api/settings", { max_concurrent_runs: Math.max(1, value) }),
    onSuccess: (data) => qc.setQueryData(["settings"], data)
  });
  return { current: settings.data?.max_concurrent_runs ?? 2, save };
}
