import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import type { EnvironmentRecord, PoolSelection, ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { toastMessage, useToast } from "./Toast";
import { Modal } from "./Modal";
import { PoolPicker } from "./PoolPicker";

// Generation tokens usable in any input (resolved server-side per run; {datetime} at container run
// time). Clicking one appends it to the field — the old "generation logic per input" flow.
export const GENERATION_TOKENS = ["{random}", "{datetime}", "{increment}", "{uuid}", "{date}", "{uniq_number}"] as const;

export function TokenBar({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
      {GENERATION_TOKENS.map((token) => (
        <button
          key={token}
          type="button"
          onClick={() => onInsert(token)}
          title={`Insert ${token}`}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "var(--mono)",
            fontSize: 11,
            padding: "1px 6px"
          }}
        >
          {token}
        </button>
      ))}
    </div>
  );
}

interface MaskedAccount {
  login: string;
}
interface MerchantLite {
  name: string;
}
interface ServerBindingsPreview {
  server_username: string;
  has_password: boolean;
  has_2faotp: boolean;
  server_merchant: string;
  extra: Record<string, string>;
  required_server_inputs?: string[];
  missing_server_inputs?: string[];
}

// RunConfig wizard (Phase 3 / 3.21). Lets the user fill a scenario's declared inputs and pick
// env / stand account / merchant before running — the gap the plain "▶ Run" button couldn't cover.
// On submit it POSTs /api/scenarios/:id/run and follows the run (or the runs list for a batch).
export function RunWizard({
  scenario,
  projectId,
  onClose
}: {
  scenario: ScenarioRecord;
  projectId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const envs = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api.get<EnvironmentRecord[]>(`/api/projects/${projectId}/environments`)
  });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<MaskedAccount[]>("/api/accounts") });
  const merchants = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<MerchantLite[]>("/api/merchants") });

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [envId, setEnvId] = useState(scenario.env_id ?? "");
  const [account, setAccount] = useState("");
  const [merchant, setMerchant] = useState("");

  // Live preview of what {server_*} placeholders resolve to for the current account/merchant
  // selection (secrets masked). Refetches whenever the selection changes.
  const preview = useQuery({
    queryKey: ["run-preview", scenario.id, account, merchant],
    queryFn: () =>
      api.post<ServerBindingsPreview>(`/api/scenarios/${scenario.id}/run/preview`, {
        account_login: account || undefined,
        merchant_name: merchant || undefined
      })
  });
  const [times, setTimes] = useState(1);
  // Per-input pool selections (input name -> pool), an address-safety toggle, and the Playwright
  // default timeout (ms).
  const [pools, setPools] = useState<Record<string, PoolSelection>>({});
  const [ensureAddress, setEnsureAddress] = useState(false);
  // When on, the run inserts nothing for any input/pool/server variable (they all resolve to empty).
  const [ignoreVars, setIgnoreVars] = useState(false);
  // Individual inputs to skip (insert nothing) — the per-variable form of ignoreVars.
  const [ignoredInputs, setIgnoredInputs] = useState<Set<string>>(new Set());
  const toggleIgnored = (name: string, on: boolean) =>
    setIgnoredInputs((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const [pwTimeout, setPwTimeout] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const poolSelections = Object.fromEntries(Object.entries(pools).filter(([, v]) => v?.pool_id));
      const body: Record<string, unknown> = {
        inputs,
        amount_times_to_run: Math.max(1, times),
        pool_selections: poolSelections,
        ensure_right_address_to_run: ensureAddress,
        ignore_variables: ignoreVars,
        ignored_inputs: Array.from(ignoredInputs)
      };
      const timeoutMs = Number(pwTimeout);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 1) {
        body.default_timeout_ms = Math.trunc(timeoutMs);
      }
      if (envId) body.env_id = envId;
      if (account) body.account_login = account;
      if (merchant) body.merchant_name = merchant;
      const res = await api.post<{ id?: string; runs?: Array<{ id: string }> }>(
        `/api/scenarios/${scenario.id}/run`,
        body
      );
      onClose();
      if (res.id) navigate(`/runs/${res.id}`);
      else navigate("/runs");
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={560}>
        <h2 style={{ margin: 0 }}>Run · {scenario.name}</h2>

        {scenario.inputs.length > 0 && (
          <>
            <strong style={{ fontSize: 13, color: "var(--text-muted)" }}>Inputs</strong>
            {scenario.inputs.map((spec) => (
              <label key={spec.name} style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1 }}>
                    {spec.name}
                    {spec.type === "2fa_otp" ? " · 🔐 2FA" : ""}
                    {spec.description ? ` — ${spec.description}` : ""}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }} title="Insert nothing for this input">
                    <input
                      type="checkbox"
                      checked={ignoreVars || ignoredInputs.has(spec.name)}
                      disabled={ignoreVars}
                      onChange={(e) => toggleIgnored(spec.name, e.target.checked)}
                    />
                    skip
                  </span>
                </span>
                {ignoreVars || ignoredInputs.has(spec.name) ? (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                    Skipped — nothing will be inserted for this input.
                  </span>
                ) : (
                  <>
                    <input
                      value={inputs[spec.name] ?? ""}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [spec.name]: e.target.value }))}
                      placeholder={pools[spec.name]?.pool_id ? "(from pool)" : spec.name}
                    />
                    <TokenBar onInsert={(token) => setInputs((prev) => ({ ...prev, [spec.name]: (prev[spec.name] ?? "") + token }))} />
                    <PoolPicker
                      projectId={projectId}
                      value={pools[spec.name] ?? null}
                      onChange={(next) =>
                        setPools((prev) => {
                          const copy = { ...prev };
                          if (next) copy[spec.name] = next;
                          else delete copy[spec.name];
                          return copy;
                        })
                      }
                    />
                  </>
                )}
              </label>
            ))}
          </>
        )}

        <label style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Environment</span>
          <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">(scenario default)</option>
            {(envs.data ?? []).map((env) => (
              <option key={env.id} value={env.id}>
                {env.name} — {env.base_url}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Stand account (optional)</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">(none)</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.login} value={a.login}>
                {a.login}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Merchant (optional)</span>
          <select value={merchant} onChange={(e) => setMerchant(e.target.value)}>
            <option value="">(none)</option>
            {(merchants.data ?? []).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        {(preview.data?.missing_server_inputs?.length ?? 0) > 0 && (
          <div
            style={{
              fontSize: 12,
              border: "1px solid var(--status-failed)",
              borderRadius: 4,
              padding: 8,
              display: "grid",
              gap: 2
            }}
          >
            <strong style={{ color: "var(--status-failed)" }}>⚠ Missing configuration</strong>
            <div style={{ color: "var(--text-muted)" }}>
              This scenario needs {preview.data?.missing_server_inputs?.map((n) => `{${n}}`).join(", ")}, but it isn't
              configured for this project. Pick a stand account/merchant above, or set it in{" "}
              <Link to={`/projects/${projectId}`} onClick={onClose}>
                project Settings
              </Link>
              . You can still run — it will fail if the value stays empty.
            </div>
          </div>
        )}

        {preview.data && (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 8,
              display: "grid",
              gap: 2
            }}
          >
            <strong style={{ color: "var(--text)" }}>Resolved server vars</strong>
            <div>{"{server_username}"} → {preview.data.server_username || "—"}</div>
            <div>{"{server_password}"} → {preview.data.has_password ? "set" : "unset"}</div>
            <div>{"{server_2faotp}"} → {preview.data.has_2faotp ? "set" : "unset"}</div>
            <div>{"{server_merchant}"} → {preview.data.server_merchant || "—"}</div>
            {Object.entries(preview.data.extra).map(([key, value]) => (
              <div key={key}>
                {`{${key}}`} → {value}
              </div>
            ))}
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={ensureAddress} onChange={(e) => setEnsureAddress(e.target.checked)} />
          Ensure the right address network (validate pool/typed addresses against the scenario)
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={ignoreVars} onChange={(e) => setIgnoreVars(e.target.checked)} />
          Ignore variables — run without inserting any inputs
        </label>
        {ignoreVars && (
          <div style={{ fontSize: 12, color: "var(--status-failed)" }}>
            Every input, pool value and server credential will be empty for this run — nothing is inserted.
          </div>
        )}

        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Run count</span>
            <input type="number" min={1} value={times} onChange={(e) => setTimes(Number(e.target.value) || 1)} style={{ width: 100 }} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Playwright timeout, ms (optional)</span>
            <input
              type="number"
              min={1}
              value={pwTimeout}
              onChange={(e) => setPwTimeout(e.target.value)}
              placeholder="default"
              style={{ width: 140 }}
            />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "…" : "▶ Run"}
          </Button>
        </div>
    </Modal>
  );
}
