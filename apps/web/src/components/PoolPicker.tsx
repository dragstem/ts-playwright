import { useQuery } from "@tanstack/react-query";
import type { PoolItemRecord, PoolRecord, PoolSelection } from "@ts-playwright/shared";
import { api } from "../api";

// Per-input pool selector. Picks a pool (drawn from at run time) and optionally pins a specific
// item; leaving the item on "auto" lets the pool's allocation strategy choose. Emits a PoolSelection
// keyed elsewhere by input name, or null to clear. Env scope is validated server-side at run time.
export function PoolPicker({
  projectId,
  value,
  onChange
}: {
  projectId: string;
  value: PoolSelection | null;
  onChange: (next: PoolSelection | null) => void;
}) {
  const pools = useQuery({
    queryKey: ["pools", projectId],
    queryFn: () => api.get<PoolRecord[]>(`/api/pools?project_id=${encodeURIComponent(projectId)}`)
  });
  const items = useQuery({
    queryKey: ["pool-items", value?.pool_id],
    enabled: Boolean(value?.pool_id),
    queryFn: () => api.get<PoolItemRecord[]>(`/api/pools/${encodeURIComponent(value?.pool_id ?? "")}/items`)
  });

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select
        value={value?.pool_id ?? ""}
        onChange={(e) => onChange(e.target.value ? { pool_id: e.target.value, mode: "auto" } : null)}
        style={{ flex: 1 }}
        title="Draw this input's value from a pool"
      >
        <option value="">(no pool)</option>
        {(pools.data ?? []).map((pool) => (
          <option key={pool.id} value={pool.id}>
            {pool.name} · {pool.kind}
          </option>
        ))}
      </select>
      {value?.pool_id && (
        <select
          value={value.item_id ?? ""}
          onChange={(e) =>
            onChange({ pool_id: value.pool_id, item_id: e.target.value || undefined, mode: e.target.value ? "manual" : "auto" })
          }
          style={{ flex: 1 }}
          title="Pin a specific item, or auto-allocate"
        >
          <option value="">auto</option>
          {(items.data ?? [])
            .filter((item) => item.enabled)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.label || item.value}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}
