import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import type { PoolSelection, ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "./Toast";
import { Modal } from "./Modal";
import { TokenBar } from "./RunWizard";
import { PoolPicker } from "./PoolPicker";
import { useConcurrency } from "../lib/useConcurrency";

interface MaskedAccount {
  login: string;
}
interface MerchantLite {
  name: string;
}

// A 2fa_otp input with an otp_login is derived server-side, so it never needs the user.
function needsUser(spec: ScenarioRecord["inputs"][number]): boolean {
  return !(spec.type === "2fa_otp" && Boolean(spec.otp_login));
}

// Batch run wizard: launch several selected scenarios at once. Inputs shared by every scenario are
// collected ONCE; inputs unique to some scenarios are collected per scenario (and required). Each
// input can take a typed value (with generation tokens) or a pool. POSTs /api/projects/:id/folder-runs.
export function BatchRunWizard({
  projectId,
  scenarios,
  onRemoveScenario,
  onClose
}: {
  projectId: string;
  scenarios: ScenarioRecord[];
  onRemoveScenario: (scenarioId: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<MaskedAccount[]>("/api/accounts") });
  const merchants = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<MerchantLite[]>("/api/merchants") });
  const concurrency = useConcurrency();

  const [account, setAccount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [times, setTimes] = useState(1);
  const [pwTimeout, setPwTimeout] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState<number | null>(null);
  const [sharedValues, setSharedValues] = useState<Record<string, string>>({});
  const [perScenario, setPerScenario] = useState<Record<string, Record<string, string>>>({});
  const [pools, setPools] = useState<Record<string, PoolSelection>>({});
  const [ensureAddress, setEnsureAddress] = useState(false);
  // When on, every run in the batch inserts nothing for any input/pool/server variable.
  const [ignoreVars, setIgnoreVars] = useState(false);
  // Individual input names to skip (batch-wide) — the per-variable form of ignoreVars.
  const [ignoredInputs, setIgnoredInputs] = useState<Set<string>>(new Set());
  const toggleIgnored = (name: string, on: boolean) =>
    setIgnoredInputs((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const [busy, setBusy] = useState(false);

  // Which input names are declared by EVERY selected scenario (→ shared) vs only some (→ per scenario).
  const { sharedNames, perScenarioInputs } = useMemo(() => {
    const nameToScenarioIds = new Map<string, Set<string>>();
    for (const s of scenarios) {
      for (const spec of s.inputs) {
        if (!needsUser(spec)) continue;
        if (!nameToScenarioIds.has(spec.name)) nameToScenarioIds.set(spec.name, new Set());
        nameToScenarioIds.get(spec.name)?.add(s.id);
      }
    }
    const shared = [...nameToScenarioIds.entries()]
      .filter(([, ids]) => scenarios.length > 0 && ids.size === scenarios.length)
      .map(([name]) => name)
      .sort();
    const sharedSet = new Set(shared);
    const per = scenarios
      .map((s) => ({ scenario: s, inputs: s.inputs.filter((spec) => needsUser(spec) && !sharedSet.has(spec.name)) }))
      .filter((entry) => entry.inputs.length > 0);
    return { sharedNames: shared, perScenarioInputs: per };
  }, [scenarios]);

  const setPerScenarioInput = (scenarioId: string, name: string, value: string) =>
    setPerScenario((prev) => ({ ...prev, [scenarioId]: { ...(prev[scenarioId] ?? {}), [name]: value } }));
  const setPool = (name: string, next: PoolSelection | null) =>
    setPools((prev) => {
      const copy = { ...prev };
      if (next) copy[name] = next;
      else delete copy[name];
      return copy;
    });

  // A non-shared input is satisfied if it has a typed value or a pool. Launch is blocked until all are.
  const missing = perScenarioInputs.flatMap(({ scenario, inputs }) =>
    inputs
      .filter(
        (spec) =>
          !ignoreVars &&
          !ignoredInputs.has(spec.name) &&
          !(perScenario[scenario.id]?.[spec.name]?.trim() || pools[spec.name]?.pool_id)
      )
      .map((spec) => ({ scenario, name: spec.name }))
  );

  const submit = async () => {
    setBusy(true);
    try {
      const ids = scenarios.map((s) => s.id);
      const sharedInputs = Object.fromEntries(Object.entries(sharedValues).filter(([, v]) => v.trim() !== ""));
      const scenarioInputs: Record<string, Record<string, string>> = {};
      for (const [scenarioId, values] of Object.entries(perScenario)) {
        const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
        if (Object.keys(kept).length > 0) scenarioInputs[scenarioId] = kept;
      }
      const poolSelections = Object.fromEntries(Object.entries(pools).filter(([, v]) => v?.pool_id));
      const timeoutMs = Number(pwTimeout);
      const execution: Record<string, unknown> = { amount_times_to_run: Math.max(1, times) };
      if (Number.isFinite(timeoutMs) && timeoutMs >= 1) execution.default_timeout_ms = Math.trunc(timeoutMs);
      const scenarioExecution = Object.fromEntries(ids.map((id) => [id, execution]));

      // Apply the concurrency limit (global) before launching, if the user changed it.
      if (maxConcurrent !== null && maxConcurrent !== concurrency.current) {
        await concurrency.save.mutateAsync(maxConcurrent);
      }

      const body: Record<string, unknown> = {
        folder_paths: [""],
        scenario_ids: ids,
        shared_inputs: sharedInputs,
        scenario_inputs: scenarioInputs,
        pool_selections: poolSelections,
        ensure_right_address_to_run: ensureAddress,
        ignore_variables: ignoreVars,
        ignored_inputs: Array.from(ignoredInputs),
        scenario_execution: scenarioExecution
      };
      if (account) body.account_login = account;
      if (merchant) body.merchant_name = merchant;
      const res = await api.post<{ batch_id: string | null }>(`/api/projects/${projectId}/folder-runs`, body);
      onClose();
      navigate(res.batch_id ? `/batches/${res.batch_id}` : "/batches");
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const inputRow = (name: string, value: string, onValue: (v: string) => void, required: boolean) => {
    const skipped = ignoreVars || ignoredInputs.has(name);
    return (
      <div key={name} style={{ display: "grid", gap: 2, marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: !skipped && required && !value.trim() && !pools[name]?.pool_id ? "var(--status-failed)" : "var(--text-muted)" }}>
          <span style={{ flex: 1 }}>
            {name}
            {required && !skipped ? " · required" : ""}
            {!skipped && pools[name]?.pool_id ? " · from pool" : ""}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }} title="Insert nothing for this input">
            <input type="checkbox" checked={skipped} disabled={ignoreVars} onChange={(e) => toggleIgnored(name, e.target.checked)} />
            skip
          </span>
        </span>
        {skipped ? (
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            Skipped — nothing will be inserted for this input.
          </span>
        ) : (
          <>
            <input value={value} onChange={(e) => onValue(e.target.value)} placeholder={pools[name]?.pool_id ? "(from pool)" : name} />
            <TokenBar onInsert={(token) => onValue((value ?? "") + token)} />
            <PoolPicker projectId={projectId} value={pools[name] ?? null} onChange={(next) => setPool(name, next)} />
          </>
        )}
      </div>
    );
  };

  return (
    <Modal onClose={onClose} width={600}>
        <h2 style={{ margin: 0 }}>Run {scenarios.length} scenario(s)</h2>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Each scenario runs on its own environment. Shared inputs (declared by all) are entered once;
          inputs unique to some scenarios are required per scenario. A pool applies to every scenario
          declaring that input name.
        </p>

        {/* Selected scenarios, removable */}
        <div style={{ maxHeight: 150, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8, display: "grid", gap: 2 }}>
          {scenarios.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ flex: 1 }}>
                <span style={{ color: "var(--text-muted)" }}>{s.folder_path || "/"} · </span>
                <strong>{s.name}</strong>
              </span>
              <button
                type="button"
                onClick={() => onRemoveScenario(s.id)}
                title="Remove from this batch"
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "1px 7px" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {sharedNames.length > 0 && (
          <div>
            <strong style={{ fontSize: 13, color: "var(--text-muted)" }}>Shared inputs</strong>
            {sharedNames.map((name) =>
              inputRow(name, sharedValues[name] ?? "", (v) => setSharedValues((prev) => ({ ...prev, [name]: v })), false)
            )}
          </div>
        )}

        {perScenarioInputs.length > 0 && (
          <div>
            <strong style={{ fontSize: 13, color: "var(--text-muted)" }}>Per-scenario inputs</strong>
            {perScenarioInputs.map(({ scenario, inputs }) => (
              <div key={scenario.id} style={{ margin: "6px 0 0 8px" }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{scenario.name}</div>
                {inputs.map((spec) =>
                  inputRow(
                    spec.name,
                    perScenario[scenario.id]?.[spec.name] ?? "",
                    (v) => setPerScenarioInput(scenario.id, spec.name, v),
                    true
                  )
                )}
              </div>
            ))}
          </div>
        )}

        <label style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Stand account (optional)</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">(none)</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.login} value={a.login}>{a.login}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Merchant (optional)</span>
          <select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
            <option value="">(none)</option>
            {(merchants.data ?? []).map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={ensureAddress} onChange={(e) => setEnsureAddress(e.target.checked)} />
          Ensure the right address network for address/wallet inputs
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={ignoreVars} onChange={(e) => setIgnoreVars(e.target.checked)} />
          Ignore variables — run without inserting any inputs
        </label>
        {ignoreVars && (
          <div style={{ fontSize: 12, color: "var(--status-failed)" }}>
            Every input, pool value and server credential will be empty for all runs in this batch.
          </div>
        )}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Repeat each scenario × N</span>
            <input type="number" min={1} value={times} onChange={(e) => setTimes(Number(e.target.value) || 1)} style={{ width: 110 }} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Playwright timeout, ms</span>
            <input type="number" min={1} value={pwTimeout} onChange={(e) => setPwTimeout(e.target.value)} placeholder="default" style={{ width: 120 }} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Max concurrent (server-wide)</span>
            <input
              type="number"
              min={1}
              value={maxConcurrent ?? concurrency.current}
              onChange={(e) => setMaxConcurrent(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 130 }}
            />
          </label>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>
          "Repeat" creates N runs per scenario; "Max concurrent" is how many containers run at once (global).
        </p>

        {missing.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--status-failed)" }}>
            Fill {missing.length} required per-scenario input(s) before launching (a value, a token, or a pool).
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || scenarios.length === 0 || missing.length > 0} onClick={() => void submit()}>
            {busy ? "…" : `▶ Run ${scenarios.length}`}
          </Button>
        </div>
    </Modal>
  );
}
