import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import type { PoolRecord, PoolItemRecord, ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { ScopeLegend } from "../components/ScopeLegend";
import { useT } from "../i18n";

const KINDS = ["deposit_address", "payout_address", "trace_id", "custom"] as const;
const STRATEGIES = ["manual", "first_enabled", "round_robin", "random", "template"] as const;

// Pools and their items (the values fed into runs — addresses, trace IDs, …). Read-mostly cabinet:
// create a pool, add/delete manual items, delete a pool. Advanced wiring (fetch/auto-import) stays
// server-side for now.
export function Pools() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const pools = useQuery({ queryKey: ["pools"], queryFn: () => api.get<PoolRecord[]>("/api/pools") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectRecord[]>("/api/projects") });
  const projectName = (id: string | null) =>
    id ? projects.data?.find((p) => p.id === id)?.name ?? id : "global";

  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("custom");
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>("manual");
  const [scope, setScope] = useState(""); // "" = global, else project_id
  const [openPool, setOpenPool] = useState<string | null>(null);

  const createPool = useMutation({
    mutationFn: () =>
      api.post("/api/pools", { name: name.trim(), kind, allocation_strategy: strategy, project_id: scope || null }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["pools"] });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const deletePool = useMutation({
    mutationFn: (id: string) => api.del(`/api/pools/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pools"] })
  });

  return (
    <div>
      <h1>{t("page.pools")}</h1>
      <p style={{ color: "var(--text-muted)" }}>Reusable value sets consumed by runs (addresses, trace IDs, …).</p>
      <ScopeLegend />

      <div className="tsp-card" style={{ display: "flex", gap: 8, flexWrap: "wrap", maxWidth: 640, marginBottom: 16 }}>
        <input placeholder={t("form.pool_name")} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value as (typeof STRATEGIES)[number])}>
          {STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} title={t("form.scope")}>
          <option value="">{t("form.scope_global")}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={!name.trim() || createPool.isPending} onClick={() => createPool.mutate()}>
          {t("action.create")}
        </Button>
      </div>

      {pools.isLoading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {(pools.data ?? []).map((p) => (
          <div key={p.id} className="tsp-card">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={() => setOpenPool(openPool === p.id ? null : p.id)}
                style={{ flex: 1, textAlign: "left", background: "none", border: "none", color: "var(--text)", cursor: "pointer" }}
              >
                <strong>{p.name}</strong>{" "}
                <span className="tsp-badge" data-status="queued">
                  {p.kind}
                </span>{" "}
                <span className="tsp-badge" data-status={p.project_id ? "running" : "queued"}>
                  {projectName(p.project_id)}
                </span>{" "}
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.allocation_strategy}</span>
              </button>
              <Button onClick={() => setOpenPool(openPool === p.id ? null : p.id)}>
                {openPool === p.id ? "Hide items" : "Items"}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm({ message: `Delete pool "${p.name}" and all its items?`, confirmLabel: t("action.delete"), danger: true })) {
                    deletePool.mutate(p.id);
                  }
                }}
              >
                {t("action.delete")}
              </Button>
            </div>
            {openPool === p.id && <PoolItems poolId={p.id} />}
          </div>
        ))}
        {pools.data?.length === 0 && <p style={{ color: "var(--text-muted)" }}>No pools yet.</p>}
      </div>
    </div>
  );
}

function PoolItems({ poolId }: { poolId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ["pool-items", poolId];
  const items = useQuery({ queryKey: key, queryFn: () => api.get<PoolItemRecord[]>(`/api/pools/${poolId}/items`) });
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [bulk, setBulk] = useState("");
  // One value per line; blanks trimmed away. id + label are auto-generated server-side.
  const bulkValues = bulk.split("\n").map((line) => line.trim()).filter(Boolean);

  const add = useMutation({
    mutationFn: () => api.post(`/api/pools/${poolId}/items`, { value: value.trim(), label: label.trim() }),
    onSuccess: () => {
      setValue("");
      setLabel("");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const addBulk = useMutation({
    mutationFn: () => api.post<{ created: number }>(`/api/pools/${poolId}/items/bulk`, { values: bulkValues }),
    onSuccess: (res) => {
      setBulk("");
      qc.invalidateQueries({ queryKey: key });
      toast.success(`Added ${res.created} item${res.created === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error(toastMessage(e))
  });

  const del = useMutation({
    mutationFn: (itemId: string) => api.del(`/api/pools/${poolId}/items/${encodeURIComponent(itemId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key })
  });

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
        <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button disabled={!value.trim() || add.isPending} onClick={() => add.mutate()}>
          Add item
        </Button>
      </div>
      <details style={{ marginBottom: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
          Bulk add — one value per line
        </summary>
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          <textarea
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            placeholder={"one value per line\naddr_1\naddr_2\naddr_3"}
            rows={5}
            style={{ fontFamily: "var(--mono)", fontSize: 13, resize: "vertical", width: "100%" }}
          />
          <div>
            <Button disabled={bulkValues.length === 0 || addBulk.isPending} onClick={() => addBulk.mutate()}>
              Add {bulkValues.length || ""} item{bulkValues.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </details>
      {items.isLoading && <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading…</p>}
      <div style={{ display: "grid", gap: 4 }}>
        {(items.data ?? []).map((it) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <code style={{ flex: 1, fontFamily: "var(--mono)" }}>{it.value}</code>
            {it.label && <span style={{ color: "var(--text-muted)" }}>{it.label}</span>}
            {!it.enabled && <span className="tsp-badge" data-status="failed">disabled</span>}
            <Button
              variant="danger"
              onClick={async () => {
                if (await confirm({ message: `Delete pool item "${it.value}"?`, confirmLabel: "Delete", danger: true })) {
                  del.mutate(it.id);
                }
              }}
            >
              ✕
            </Button>
          </div>
        ))}
        {items.data?.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No items.</span>}
      </div>
    </div>
  );
}
