import { randomBytes, randomUUID } from "node:crypto";
import {
  normalizeFolderPath,
  normalizeOtpLogin,
  normalizeTotpSecret,
  SERVER_2FA_OTP_INPUT_NAME,
  SERVER_INPUT_NAMES,
  SERVER_INPUT_TOKENS,
  SERVER_MERCHANT_INPUT_NAME,
  SERVER_PASSWORD_INPUT_NAME,
  SERVER_USERNAME_INPUT_NAME,
  type AccountRecord,
  type AppState,
  type EnvironmentRecord,
  type InputSpec,
  type MerchantRecord,
  type PoolItemRecord,
  type PoolRecord,
  type PoolSelection,
  type RunLogEntry,
  type RunRecord,
  type ScenarioRecord
} from "@ts-playwright/shared";
import { openSecret } from "./secrets";

export interface PreparedRunPlan {
  run: RunRecord;
  scenario: ScenarioRecord;
  env: EnvironmentRecord;
  inputs: Record<string, string>;
  otp_secrets: Record<string, string>;
  execution_stage: number;
  default_timeout_ms: number | null;
  ignore_variables: boolean;
  ignored_inputs: string[];
}

const DEFAULT_AUTO_INPUT_TEMPLATE = "{input_name}_{folder_name}_{uniq_number}";
let automaticInputIncrement = 0;

interface SelectedBaseData {
  account: AccountRecord | null;
  merchant: MerchantRecord | null;
  server_username: string;
  server_password: string;
  server_2faotp: string;
  server_merchant: string;
  // Phase 2 / 2-R10 — arbitrary project-scoped server_* tokens beyond the four standard ones.
  // Plaintext config (not sealed at rest); substituted into input values as {key} at run time.
  extra: Record<string, string>;
}

interface ServerInputBindings {
  inputs: Record<string, string>;
  otp_secrets: Record<string, string>;
}

interface RuntimePoolResolution {
  inputs: Record<string, string>;
  snapshot: Record<string, unknown>;
}

interface PoolAllocationContext {
  selectedItemCounts: Map<string, number>;
}

interface RuntimePoolOptions {
  ensureRightAddressToRun: boolean;
  allocationContext: PoolAllocationContext;
}

type AddressFamily =
  | "avalanche_x"
  | "bitcoin"
  | "bitcoin_cash"
  | "cardano"
  | "dogecoin"
  | "evm"
  | "litecoin"
  | "ripple"
  | "solana"
  | "stellar"
  | "ton"
  | "tron";

interface AddressTarget {
  family: AddressFamily;
  networkName: string;
}

interface ResolvedPoolSelection {
  pool: PoolRecord;
  item: PoolItemRecord | null;
  value: string;
  addressFamily?: AddressFamily;
  targetNetwork?: string;
}

const NETWORK_ADDRESS_FAMILIES: Record<string, AddressFamily> = {
  "Arbitrum Ethereum": "evm",
  "Arbitrum USDC": "evm",
  "Avalanche C-Chain": "evm",
  "Avalanche X-Chain": "avalanche_x",
  "Base Ethereum": "evm",
  "Base SCOR": "evm",
  "Base USDC": "evm",
  "Binance BUSD": "evm",
  "Binance Coin": "evm",
  Bitcoin: "bitcoin",
  "Bitcoin Cash": "bitcoin_cash",
  Cardano: "cardano",
  Dogecoin: "dogecoin",
  Ethereum: "evm",
  "Ethereum LINK": "evm",
  "Ethereum PYUSD": "evm",
  "Ethereum SHIB": "evm",
  "Ethereum TUSD": "evm",
  "Ethereum USDC": "evm",
  "Ethereum USDT": "evm",
  Litecoin: "litecoin",
  "Optimism Ethereum": "evm",
  "Optimism USDC": "evm",
  Polygon: "evm",
  "Polygon TUSD": "evm",
  "Polygon USDC": "evm",
  "Polygon USDT": "evm",
  Ripple: "ripple",
  Solana: "solana",
  "Solana TRUMP": "solana",
  "Solana USDC": "solana",
  Stellar: "stellar",
  Ton: "ton",
  "Ton USDT": "ton",
  Tron: "tron",
  "Tron TUSD": "tron",
  "Tron USDC": "tron",
  "Tron USDT": "tron"
};

const NETWORK_NAMES_BY_LENGTH = Object.keys(NETWORK_ADDRESS_FAMILIES).sort(
  (left, right) => right.length - left.length || left.localeCompare(right)
);

const ADDRESS_FAMILY_ALIASES: Record<string, AddressFamily> = {
  ada: "cardano",
  arbitrum: "evm",
  avalanche_c: "evm",
  avalanche_c_chain: "evm",
  avalanchec: "evm",
  avalanche_x: "avalanche_x",
  avalanche_x_chain: "avalanche_x",
  avalanchex: "avalanche_x",
  base: "evm",
  bch: "bitcoin_cash",
  bep20: "evm",
  binance: "evm",
  binance_smart_chain: "evm",
  binancesmartchain: "evm",
  bitcoin: "bitcoin",
  bitcoin_cash: "bitcoin_cash",
  bitcoincash: "bitcoin_cash",
  bsc: "evm",
  btc: "bitcoin",
  c_chain: "evm",
  cardano: "cardano",
  doge: "dogecoin",
  dogecoin: "dogecoin",
  erc20: "evm",
  eth: "evm",
  ethereum: "evm",
  evm: "evm",
  ltc: "litecoin",
  litecoin: "litecoin",
  optimism: "evm",
  polygon: "evm",
  ripple: "ripple",
  sol: "solana",
  solana: "solana",
  stellar: "stellar",
  ton: "ton",
  toncoin: "ton",
  trc20: "tron",
  tron: "tron",
  trx: "tron",
  x_chain: "avalanche_x",
  xchain: "avalanche_x",
  xlm: "stellar",
  xrp: "ripple"
};

export function scenarioBelongsToFolderTree(scenarioFolderPath: string, folderPath: string): boolean {
  const scenarioFolder = normalizeFolderPath(scenarioFolderPath);
  const scope = normalizeFolderPath(folderPath);
  if (!scope) {
    return true;
  }
  return scenarioFolder === scope || scenarioFolder.startsWith(`${scope}/`);
}

export function collectScenariosForFolderPaths(
  state: AppState,
  projectId: string,
  folderPaths: string[]
): ScenarioRecord[] {
  const normalizedPaths = uniqueFolderPaths(folderPaths);
  return state.scenarios
    .filter(
      (scenario) =>
        scenario.project_id === projectId &&
        normalizedPaths.some((folderPath) => scenarioBelongsToFolderTree(scenario.folder_path, folderPath))
    )
    .sort(compareScenarios);
}

export function prepareScenarioRunPlan(
  state: AppState,
  scenario: ScenarioRecord,
  options: {
    batch_id?: string | null;
    env_id?: string;
    account_login?: string;
    merchant_name?: string;
    server_username?: string;
    server_password?: string;
    server_2faotp?: string;
    server_merchant?: string;
    inputs?: Record<string, string>;
    pool_selections?: Record<string, PoolSelection>;
    ensure_right_address_to_run?: boolean;
    ignore_variables?: boolean;
    ignored_inputs?: string[];
    pool_allocation_context?: PoolAllocationContext;
    runtime_snapshot?: Record<string, unknown>;
    retry_of_run_id?: string | null;
    execution_stage?: number;
    amount_times_to_run?: number;
    run_iteration?: number;
    default_timeout_ms?: number;
    triggered_by?: string;
    triggered_at?: string;
  } = {}
): PreparedRunPlan {
  const env = state.environments.find(
    (item) => item.id === (options.env_id ?? scenario.env_id) && item.project_id === scenario.project_id
  );
  if (!env) {
    throw new Error("Scenario environment not found");
  }

  const selectedBaseData = resolveSelectedBaseData(state, {
    project_id: scenario.project_id,
    account_login: options.account_login,
    merchant_name: options.merchant_name,
    server_username: options.server_username,
    server_password: options.server_password,
    server_2faotp: options.server_2faotp,
    server_merchant: options.server_merchant
  });
  const ignoreVariables = Boolean(options.ignore_variables);
  const ignoredInputs = new Set(options.ignored_inputs ?? []);
  let resolved: ReturnType<typeof resolveRunInputs>;
  let poolSnapshot: Record<string, unknown> = {};
  if (ignoreVariables) {
    // Ignore-variables mode: insert nothing. Skip pool allocation, automatic inputs, server-template
    // substitution and the required-input check — the runner blanks every input() at run time, so a
    // scenario that needs {server_*} can still be launched without those values configured.
    resolved = { inputs: {}, stored: {}, otp_secrets: {} };
  } else {
    const runtimeOnlyBindings = buildServerInputBindings(selectedBaseData);
    // Individually-skipped inputs are dropped before resolution so they aren't pool-allocated,
    // auto-filled, or treated as required; the runner also blanks them by name at run time.
    const providedInputs = omitKeys(options.inputs ?? {}, ignoredInputs);
    const poolSelections = omitKeys(options.pool_selections ?? {}, ignoredInputs);
    const poolResolution = resolveRuntimePools(state, scenario, env, providedInputs, poolSelections, {
      ensureRightAddressToRun: Boolean(options.ensure_right_address_to_run),
      allocationContext: options.pool_allocation_context ?? createPoolAllocationContext()
    });
    poolSnapshot = poolResolution.snapshot;
    const storedInputs = applyAutomaticInputs(
      scenario,
      {
        ...providedInputs,
        ...poolResolution.inputs
      },
      ignoredInputs
    );
    const runtimeInputs = resolveServerTemplatesInInputs(storedInputs, selectedBaseData);
    const missing = scenario.inputs
      .filter((spec) => !ignoredInputs.has(spec.name) && requiredInputMissing(spec, runtimeInputs))
      .map((spec) => spec.name);
    if (missing.length > 0) {
      throw new Error(`Missing required inputs: ${missing.join(", ")}`);
    }

    resolved = resolveRunInputs(
      scenario.inputs,
      runtimeInputs,
      storedInputs,
      runtimeOnlyBindings.inputs,
      runtimeOnlyBindings.otp_secrets
    );
    for (const name of ignoredInputs) {
      delete resolved.inputs[name];
      delete resolved.stored[name];
    }
  }
  const triggeredAt = options.triggered_at ?? new Date().toISOString();
  const executionStage = normalizeExecutionStage(options.execution_stage);
  const amountTimesToRun = normalizePositiveInt(options.amount_times_to_run);
  const runIteration = normalizeRunIteration(options.run_iteration, amountTimesToRun);
  const defaultTimeoutMs = normalizeDefaultTimeoutMs(options.default_timeout_ms);
  return {
    run: {
      id: randomUUID(),
      scenario_id: scenario.id,
      env_id: env.id,
      account_login: selectedBaseData.account?.login ?? null,
      merchant_name: selectedBaseData.merchant?.name ?? null,
      server_username: normalizeStoredServerValue(selectedBaseData.server_username),
      server_password: normalizeStoredServerValue(selectedBaseData.server_password),
      server_2faotp: normalizeStoredServerValue(selectedBaseData.server_2faotp),
      server_merchant: normalizeStoredServerValue(selectedBaseData.server_merchant),
      triggered_by: options.triggered_by ?? "api",
      triggered_at: triggeredAt,
      retry_of_run_id: options.retry_of_run_id ?? null,
      batch_id: options.batch_id ?? null,
      execution_stage: executionStage,
      amount_times_to_run: amountTimesToRun,
      ignore_variables: ignoreVariables,
      ignored_inputs: Array.from(ignoredInputs),
      run_iteration: runIteration,
      default_timeout_ms: defaultTimeoutMs,
      status: "queued",
      started_at: null,
      finished_at: null,
      artifacts_path: null,
      stdout_path: null,
      stderr_path: null,
      summary_json: null,
      inputs: resolved.stored,
      pool_selections: options.pool_selections ?? {},
      runtime_snapshot: options.runtime_snapshot ?? {
        ...poolSnapshot,
        ensure_right_address_to_run: Boolean(options.ensure_right_address_to_run),
        server: {
          account_login: selectedBaseData.account?.login ?? null,
          merchant_name: selectedBaseData.merchant?.name ?? null
        }
      },
      log_entries: [createQueuedRunLogEntry(triggeredAt, executionStage)],
      phase: "queued",
      phase_timings: {}
    },
    scenario,
    env,
    inputs: resolved.inputs,
    otp_secrets: resolved.otp_secrets,
    execution_stage: executionStage,
    default_timeout_ms: defaultTimeoutMs,
    ignore_variables: ignoreVariables,
    ignored_inputs: Array.from(ignoredInputs)
  };
}

export function prepareFolderRunPlans(
  state: AppState,
  projectId: string,
  folderPaths: string[],
  scenarioInputs: Record<string, Record<string, string>> = {},
  scenarioExecution: Record<string, { stage?: number; amount_times_to_run?: number; parallel_batch_size?: number; default_timeout_ms?: number }> = {},
  sharedInputs: Record<string, string> = {},
  baseSelection: {
    account_login?: string;
    merchant_name?: string;
    server_username?: string;
    server_password?: string;
    server_2faotp?: string;
    server_merchant?: string;
    pool_selections?: Record<string, PoolSelection>;
    ensure_right_address_to_run?: boolean;
    ignore_variables?: boolean;
    ignored_inputs?: string[];
  } = {},
  scenarioIds?: string[]
): PreparedRunPlan[] {
  const folderScenarios = collectScenariosForFolderPaths(state, projectId, folderPaths);
  const filterByScenarioIds = Array.isArray(scenarioIds);
  const selectedScenarioIds = filterByScenarioIds ? uniqueScenarioIds(scenarioIds) : [];
  const folderScenarioIds = new Set(folderScenarios.map((scenario) => scenario.id));
  for (const scenarioId of selectedScenarioIds) {
    if (!folderScenarioIds.has(scenarioId)) {
      throw new Error(`Scenario is not part of the selected folders: ${scenarioId}`);
    }
  }
  const selectedScenarioIdSet = new Set(selectedScenarioIds);
  const scenarios =
    filterByScenarioIds
      ? folderScenarios.filter((scenario) => selectedScenarioIdSet.has(scenario.id))
      : folderScenarios;
  const selectedIds = new Set(scenarios.map((scenario) => scenario.id));
  const batchId = randomUUID();

  for (const scenarioId of Object.keys(scenarioInputs)) {
    if (!selectedIds.has(scenarioId)) {
      throw new Error(`Scenario is not part of the selected folders: ${scenarioId}`);
    }
  }
  for (const scenarioId of Object.keys(scenarioExecution)) {
    if (!selectedIds.has(scenarioId)) {
      throw new Error(`Scenario is not part of the selected folders: ${scenarioId}`);
    }
  }

  const triggeredAt = new Date().toISOString();
  const allocationContext = createPoolAllocationContext();
  return scenarios.flatMap((scenario) => {
    const execution = scenarioExecution[scenario.id] ?? {};
    const amountTimesToRun = normalizePositiveInt(execution.amount_times_to_run);
    const parallelBatchSize = normalizeParallelBatchSize(execution.parallel_batch_size, amountTimesToRun);
    const baseStage = normalizeExecutionStage(execution.stage);
    return Array.from({ length: amountTimesToRun }, (_value, index) =>
      prepareScenarioRunPlan(state, scenario, {
        batch_id: batchId,
        account_login: baseSelection.account_login,
        merchant_name: baseSelection.merchant_name,
        server_username: baseSelection.server_username,
        server_password: baseSelection.server_password,
        server_2faotp: baseSelection.server_2faotp,
        server_merchant: baseSelection.server_merchant,
        inputs: mergeScenarioInputs(scenario.inputs, sharedInputs, scenarioInputs[scenario.id] ?? {}),
        pool_selections: baseSelection.pool_selections,
        ensure_right_address_to_run: baseSelection.ensure_right_address_to_run,
        ignore_variables: baseSelection.ignore_variables,
        ignored_inputs: baseSelection.ignored_inputs,
        pool_allocation_context: allocationContext,
        execution_stage: baseStage + Math.floor(index / parallelBatchSize),
        amount_times_to_run: amountTimesToRun,
        run_iteration: index + 1,
        default_timeout_ms: execution.default_timeout_ms,
        triggered_at: triggeredAt
      })
    );
  });
}

function resolveRuntimePools(
  state: AppState,
  scenario: ScenarioRecord,
  env: EnvironmentRecord,
  providedInputs: Record<string, string>,
  poolSelections: Record<string, PoolSelection>,
  options: RuntimePoolOptions
): RuntimePoolResolution {
  const inputs: Record<string, string> = {};
  const snapshotPools: Record<string, unknown> = {};

  for (const [inputName, selection] of Object.entries(poolSelections)) {
    const pool = state.pools.find((item) => item.id === selection.pool_id);
    const providedValue = String(providedInputs[inputName] ?? "").trim();
    if (providedValue) {
      const target =
        pool && options.ensureRightAddressToRun && shouldEnsureRightAddress(inputName, pool)
          ? requireScenarioAddressTarget(scenario, inputName, pool)
          : null;
      if (target && !valueMatchesAddressFamily(providedValue, target.family)) {
        throw new Error(
          `Provided value for ${inputName} is not a valid ${target.networkName} address (${target.family})`
        );
      }
      inputs[inputName] = providedValue;
      snapshotPools[inputName] = {
        pool_id: pool?.id ?? selection.pool_id,
        pool_name: pool?.name ?? selection.pool_id,
        pool_kind: pool?.kind ?? "custom",
        item_id: selection.item_id ?? null,
        value: providedValue,
        ...(target
          ? {
              address_family: target.family,
              target_network: target.networkName,
              ensure_right_address_to_run: true
            }
          : {})
      };
      continue;
    }
    const resolved = resolvePoolSelection(state, selection, scenario, env, inputName, options);
    inputs[inputName] = resolved.value;
    snapshotPools[inputName] = {
      pool_id: resolved.pool.id,
      pool_name: resolved.pool.name,
      pool_kind: resolved.pool.kind,
      item_id: resolved.item?.id ?? null,
      value: resolved.value,
      ...(resolved.addressFamily
        ? {
            address_family: resolved.addressFamily,
            target_network: resolved.targetNetwork ?? null,
            ensure_right_address_to_run: true
          }
        : {})
    };
  }

  for (const spec of scenario.inputs) {
    if (!isTraceInputName(spec.name)) {
      continue;
    }
    if (String(providedInputs[spec.name] ?? "").trim() || inputs[spec.name]) {
      continue;
    }
    const resolved = resolveDefaultTraceValue(state, scenario, env, spec.name);
    inputs[spec.name] = resolved.value;
    snapshotPools[spec.name] = {
      pool_id: resolved.pool?.id ?? null,
      pool_name: resolved.pool?.name ?? "default trace",
      pool_kind: "trace_id",
      item_id: resolved.item?.id ?? null,
      value: resolved.value
    };
  }

  return {
    inputs,
    snapshot: {
      pools: snapshotPools
    }
  };
}

function resolvePoolSelection(
  state: AppState,
  selection: PoolSelection,
  scenario: ScenarioRecord,
  env: EnvironmentRecord,
  inputName: string,
  options: RuntimePoolOptions
): ResolvedPoolSelection {
  const pool = state.pools.find((item) => item.id === selection.pool_id);
  if (!pool) {
    throw new Error(`Pool not found for ${inputName}: ${selection.pool_id}`);
  }
  if (!poolMatchesScope(pool, scenario, env)) {
    throw new Error(`Pool is not available for this scenario environment: ${pool.name}`);
  }
  const shouldEnsureAddress = options.ensureRightAddressToRun && shouldEnsureRightAddress(inputName, pool);
  if (pool.allocation_strategy === "template") {
    if (shouldEnsureAddress) {
      throw new Error(`Cannot ensure a real address from template pool: ${pool.name}`);
    }
    return {
      pool,
      item: null,
      value: resolvePoolTemplate(pool.template || defaultTraceTemplate(), inputName, scenario)
    };
  }
  const enabledItems = state.pool_items.filter((entry) => entry.pool_id === pool.id && entry.enabled);
  if (shouldEnsureAddress) {
    const target = requireScenarioAddressTarget(scenario, inputName, pool);
    const compatibleItems = enabledItems.filter((entry) => poolItemMatchesAddressFamily(entry, target.family));
    const selectedCompatibleItem = selection.item_id
      ? compatibleItems.find((entry) => entry.id === selection.item_id) ?? null
      : null;
    const item =
      selectedCompatibleItem ??
      pickLeastUsedPoolItem(compatibleItems, pool, state, options.allocationContext);
    if (!item) {
      throw new Error(
        `Pool ${pool.name} does not have an enabled ${target.networkName} address (${target.family}) for ${inputName}`
      );
    }
    recordPoolItemSelection(options.allocationContext, item);
    return {
      pool,
      item,
      value: item.value,
      addressFamily: target.family,
      targetNetwork: target.networkName
    };
  }

  const item = selection.item_id
    ? state.pool_items.find((entry) => entry.pool_id === pool.id && entry.id === selection.item_id)
    : pickPoolItem(enabledItems, pool, state, options.allocationContext);
  if (!item) {
    throw new Error(`Pool does not have an enabled item: ${pool.name}`);
  }
  if (!selection.item_id && pool.allocation_strategy === "round_robin") {
    recordPoolItemSelection(options.allocationContext, item);
  }
  return { pool, item, value: item.value };
}

function resolveDefaultTraceValue(
  state: AppState,
  scenario: ScenarioRecord,
  env: EnvironmentRecord,
  inputName: string
): { pool: PoolRecord | null; item: PoolItemRecord | null; value: string } {
  const pool = state.pools.find((item) => item.kind === "trace_id" && poolMatchesScope(item, scenario, env));
  if (!pool) {
    return {
      pool: null,
      item: null,
      value: resolvePoolTemplate(defaultTraceTemplate(), inputName, scenario)
    };
  }
  return resolvePoolSelection(state, { pool_id: pool.id, mode: "auto" }, scenario, env, inputName, {
    ensureRightAddressToRun: false,
    allocationContext: createPoolAllocationContext()
  });
}

function poolMatchesScope(pool: PoolRecord, scenario: ScenarioRecord, env: EnvironmentRecord): boolean {
  if (pool.project_id && pool.project_id !== scenario.project_id) {
    return false;
  }
  if (pool.env_ids.length > 0 && !pool.env_ids.includes(env.id)) {
    return false;
  }
  return true;
}

function createPoolAllocationContext(): PoolAllocationContext {
  return {
    selectedItemCounts: new Map<string, number>()
  };
}

function pickPoolItem(
  items: PoolItemRecord[],
  pool: PoolRecord,
  state: AppState,
  allocationContext: PoolAllocationContext
): PoolItemRecord | null {
  if (items.length === 0) {
    return null;
  }
  if (pool.allocation_strategy === "random") {
    return items[Math.floor(Math.random() * items.length)] ?? null;
  }
  if (pool.allocation_strategy === "round_robin") {
    return pickLeastUsedPoolItem(items, pool, state, allocationContext);
  }
  return (
    items
      .slice()
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))[0] ?? null
  );
}

function pickLeastUsedPoolItem(
  items: PoolItemRecord[],
  pool: PoolRecord,
  state: AppState,
  allocationContext: PoolAllocationContext
): PoolItemRecord | null {
  if (items.length === 0) {
    return null;
  }
  const historicalUsage = buildPoolItemUsageStats(state, pool.id);
  return (
    items
      .slice()
      .sort((left, right) => {
        const leftUsage = poolItemUseCount(left, historicalUsage, allocationContext);
        const rightUsage = poolItemUseCount(right, historicalUsage, allocationContext);
        if (leftUsage !== rightUsage) {
          return leftUsage - rightUsage;
        }
        const leftLastUsedAt = historicalUsage.get(left.id)?.lastUsedAt ?? "";
        const rightLastUsedAt = historicalUsage.get(right.id)?.lastUsedAt ?? "";
        if (leftLastUsedAt !== rightLastUsedAt) {
          return leftLastUsedAt.localeCompare(rightLastUsedAt);
        }
        return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
      })[0] ?? null
  );
}

function poolItemUseCount(
  item: PoolItemRecord,
  historicalUsage: Map<string, { count: number; lastUsedAt: string }>,
  allocationContext: PoolAllocationContext
): number {
  return (historicalUsage.get(item.id)?.count ?? 0) + (allocationContext.selectedItemCounts.get(item.id) ?? 0);
}

function recordPoolItemSelection(allocationContext: PoolAllocationContext, item: PoolItemRecord): void {
  allocationContext.selectedItemCounts.set(item.id, (allocationContext.selectedItemCounts.get(item.id) ?? 0) + 1);
}

function buildPoolItemUsageStats(
  state: AppState,
  poolId: string
): Map<string, { count: number; lastUsedAt: string }> {
  const stats = new Map<string, { count: number; lastUsedAt: string }>();
  for (const run of state.runs) {
    const poolsSnapshot = objectRecord(run.runtime_snapshot?.pools);
    if (!poolsSnapshot) {
      continue;
    }
    for (const rawSnapshot of Object.values(poolsSnapshot)) {
      const snapshot = objectRecord(rawSnapshot);
      if (!snapshot || snapshot.pool_id !== poolId || typeof snapshot.item_id !== "string" || !snapshot.item_id) {
        continue;
      }
      const current = stats.get(snapshot.item_id) ?? { count: 0, lastUsedAt: "" };
      current.count += 1;
      const usedAt = run.triggered_at || run.started_at || run.finished_at || "";
      if (usedAt && usedAt > current.lastUsedAt) {
        current.lastUsedAt = usedAt;
      }
      stats.set(snapshot.item_id, current);
    }
  }
  return stats;
}

function shouldEnsureRightAddress(inputName: string, pool: PoolRecord): boolean {
  const normalizedInputName = normalizeDescriptor(inputName);
  return (
    normalizedInputName.includes("address") ||
    normalizedInputName.includes("wallet") ||
    pool.kind === "deposit_address" ||
    pool.kind === "payout_address"
  );
}

function requireScenarioAddressTarget(scenario: ScenarioRecord, inputName: string, pool: PoolRecord): AddressTarget {
  const target = inferScenarioAddressTarget(scenario);
  if (!target) {
    throw new Error(
      `Cannot infer target address network for ${inputName} in scenario ${scenario.name} from folder ${scenario.folder_path} and pool ${pool.name}`
    );
  }
  return target;
}

function inferScenarioAddressTarget(scenario: ScenarioRecord): AddressTarget | null {
  const folderParts = normalizeFolderPath(scenario.folder_path)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse();
  const candidates = [scenario.name, ...folderParts, scenario.slug];
  for (const candidate of candidates) {
    for (const networkName of NETWORK_NAMES_BY_LENGTH) {
      if (!textIncludesNetworkName(candidate, networkName)) {
        continue;
      }
      return {
        networkName,
        family: NETWORK_ADDRESS_FAMILIES[networkName]
      };
    }
  }
  return null;
}

function poolItemMatchesAddressFamily(item: PoolItemRecord, targetFamily: AddressFamily): boolean {
  const explicitFamilies = inferExplicitAddressFamilies(item);
  if (explicitFamilies.size > 0 && !explicitFamilies.has(targetFamily)) {
    return false;
  }
  if (!valueMatchesAddressFamily(item.value, targetFamily)) {
    return false;
  }
  if (explicitFamilies.size > 0) {
    return true;
  }
  const inferredFamilies = inferAddressFamiliesFromValue(item.value);
  return inferredFamilies.size === 1 && inferredFamilies.has(targetFamily);
}

function inferExplicitAddressFamilies(item: PoolItemRecord): Set<AddressFamily> {
  const families = new Set<AddressFamily>();
  for (const value of [
    item.network,
    item.currency,
    ...metadataDescriptorValues(item.metadata, [
      "address_family",
      "addressFamily",
      "family",
      "network",
      "chain",
      "blockchain",
      "protocol"
    ])
  ]) {
    addAddressFamilyFromDescriptor(families, value);
  }
  return families;
}

function metadataDescriptorValues(metadata: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      values.push(...value.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  return values;
}

function addAddressFamilyFromDescriptor(families: Set<AddressFamily>, value: string): void {
  const normalized = normalizeDescriptor(value);
  if (!normalized) {
    return;
  }
  const directAlias = ADDRESS_FAMILY_ALIASES[normalized];
  if (directAlias) {
    families.add(directAlias);
  }
  for (const networkName of NETWORK_NAMES_BY_LENGTH) {
    if (!textIncludesNetworkName(normalized, networkName)) {
      continue;
    }
    families.add(NETWORK_ADDRESS_FAMILIES[networkName]);
    return;
  }
  for (const [alias, family] of Object.entries(ADDRESS_FAMILY_ALIASES)) {
    if (normalized === alias || normalized.includes(`_${alias}_`) || normalized.startsWith(`${alias}_`) || normalized.endsWith(`_${alias}`)) {
      families.add(family);
    }
  }
}

function valueMatchesAddressFamily(value: string, family: AddressFamily): boolean {
  const trimmed = String(value || "").trim();
  switch (family) {
    case "avalanche_x":
      return /^X-avax1[0-9a-z]{20,}$/i.test(trimmed);
    case "bitcoin":
      return /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(trimmed);
    case "bitcoin_cash":
      return /^(?:bitcoincash:)?[qp][0-9a-z]{41,}$/i.test(trimmed);
    case "cardano":
      return /^(?:addr1[0-9a-z]{20,}|Ae2[1-9A-HJ-NP-Za-km-z]{20,}|DdzFF[1-9A-HJ-NP-Za-km-z]{20,})$/.test(trimmed);
    case "dogecoin":
      return /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(trimmed);
    case "evm":
      return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
    case "litecoin":
      return /^(?:ltc1[ac-hj-np-z02-9]{11,71}|[LM][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(trimmed);
    case "ripple":
      return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(trimmed);
    case "solana":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
    case "stellar":
      return /^G[A-Z2-7]{55}$/.test(trimmed);
    case "ton":
      return /^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/.test(trimmed);
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed);
  }
}

function inferAddressFamiliesFromValue(value: string): Set<AddressFamily> {
  const families = new Set<AddressFamily>();
  const allFamilies: AddressFamily[] = [
    "avalanche_x",
    "bitcoin",
    "bitcoin_cash",
    "cardano",
    "dogecoin",
    "evm",
    "litecoin",
    "ripple",
    "solana",
    "stellar",
    "ton",
    "tron"
  ];
  for (const family of allFamilies) {
    if (valueMatchesAddressFamily(value, family)) {
      families.add(family);
    }
  }
  if (families.size > 1 && families.has("solana")) {
    families.delete("solana");
  }
  return families;
}

function textIncludesNetworkName(text: string, networkName: string): boolean {
  const normalizedText = normalizeDescriptor(text);
  const normalizedNetwork = normalizeDescriptor(networkName);
  if (!normalizedText || !normalizedNetwork) {
    return false;
  }
  return (
    normalizedText === normalizedNetwork ||
    normalizedText.includes(`_${normalizedNetwork}_`) ||
    normalizedText.startsWith(`${normalizedNetwork}_`) ||
    normalizedText.endsWith(`_${normalizedNetwork}`)
  );
}

function normalizeDescriptor(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mergeScenarioInputs(
  scenarioInputSpecs: InputSpec[],
  sharedInputs: Record<string, string>,
  scenarioInputs: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  const knownNames = new Set(scenarioInputSpecs.map((item) => item.name));

  for (const [name, value] of Object.entries(sharedInputs)) {
    if (!knownNames.has(name)) {
      continue;
    }
    merged[name] = String(value ?? "");
  }

  for (const [name, value] of Object.entries(scenarioInputs)) {
    merged[name] = String(value ?? "");
  }

  return merged;
}

function requiredInputMissing(spec: InputSpec, providedInputs: Record<string, string>): boolean {
  if (spec.type === "2fa_otp" && spec.otp_login) {
    return false;
  }
  if (supportsAutomaticInputValue(spec)) {
    return false;
  }
  return !String(providedInputs[spec.name] ?? "").trim();
}

// Drop keys listed in `exclude` from a record (returns the same reference when nothing is excluded).
function omitKeys<T>(record: Record<string, T>, exclude: Set<string>): Record<string, T> {
  if (exclude.size === 0) {
    return record;
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => !exclude.has(key)));
}

function applyAutomaticInputs(
  scenario: ScenarioRecord,
  providedInputs: Record<string, string>,
  skip: Set<string> = new Set()
): Record<string, string> {
  const resolvedInputs = Object.fromEntries(
    Object.entries(providedInputs).map(([name, value]) => [name, String(value ?? "")])
  );

  for (const spec of scenario.inputs) {
    if (skip.has(spec.name)) {
      continue;
    }
    if (!supportsAutomaticInputValue(spec)) {
      continue;
    }
    const template = String(resolvedInputs[spec.name] ?? "").trim() || DEFAULT_AUTO_INPUT_TEMPLATE;
    resolvedInputs[spec.name] = resolveAutomaticInputTemplate(template, spec.name, scenario);
  }

  return resolvedInputs;
}

function resolveRunInputs(
  scenarioInputs: InputSpec[],
  providedInputs: Record<string, string>,
  storedInputsProvided: Record<string, string> = providedInputs,
  runtimeOnlyInputs: Record<string, string> = {},
  runtimeOnlyOtpSecrets: Record<string, string> = {}
): { inputs: Record<string, string>; stored: Record<string, string>; otp_secrets: Record<string, string> } {
  const inputs: Record<string, string> = {};
  const stored: Record<string, string> = {};
  const otpSecrets: Record<string, string> = { ...runtimeOnlyOtpSecrets };
  const knownNames = new Set(scenarioInputs.map((item) => item.name));

  for (const spec of scenarioInputs) {
    const rawValue = String(providedInputs[spec.name] ?? "");
    const storedValue = String(storedInputsProvided[spec.name] ?? "");
    if (spec.type === "2fa_otp") {
      const login = normalizeOtpLogin(spec.otp_login || rawValue);
      if (!login) {
        if (spec.name in storedInputsProvided) {
          stored[spec.name] = storedValue;
        }
        continue;
      }
      if (spec.name in storedInputsProvided) {
        stored[spec.name] = containsServerInputToken(storedValue) ? storedValue : login;
      } else {
        stored[spec.name] = login;
      }
      const normalizedSecret = tryNormalizeTotpSecret(login);
      if (normalizedSecret) {
        otpSecrets[spec.name] = normalizedSecret;
      } else {
        inputs[spec.name] = login;
      }
      continue;
    }
    if (spec.name in providedInputs) {
      inputs[spec.name] = rawValue;
      stored[spec.name] = storedValue;
    }
  }

  for (const [name, value] of Object.entries(providedInputs)) {
    if (knownNames.has(name)) {
      continue;
    }
    inputs[name] = String(value ?? "");
    if (name in storedInputsProvided) {
      stored[name] = String(storedInputsProvided[name] ?? "");
    }
  }

  for (const [name, value] of Object.entries(runtimeOnlyInputs)) {
    inputs[name] = String(value ?? "");
  }

  return { inputs, stored, otp_secrets: otpSecrets };
}

// Among records matching `match`, prefer one scoped to `projectId`, then a global (null) one.
function pickProjectScoped<T extends { project_id?: string | null }>(
  items: T[],
  match: (item: T) => boolean,
  projectId?: string
): T | null {
  const candidates = items.filter(match);
  if (candidates.length === 0) {
    return null;
  }
  if (projectId) {
    const scoped = candidates.find((item) => item.project_id === projectId);
    if (scoped) {
      return scoped;
    }
  }
  return candidates.find((item) => !item.project_id) ?? candidates[0];
}

function resolveSelectedBaseData(
  state: AppState,
  selection: {
    project_id?: string;
    account_login?: string;
    merchant_name?: string;
    server_username?: string;
    server_password?: string;
    server_2faotp?: string;
    server_merchant?: string;
  }
): SelectedBaseData {
  const normalizedAccountLogin = normalizeNonSecretServerValue(selection.account_login);
  const normalizedMerchantName = normalizeNonSecretServerValue(selection.merchant_name);
  const explicitUsername = normalizeNonSecretServerValue(selection.server_username);
  const explicitPassword = normalizeSecretServerValue(selection.server_password);
  const explicitTwoFactorOtp = normalizeNonSecretServerValue(selection.server_2faotp);
  const explicitMerchant = normalizeNonSecretServerValue(selection.server_merchant);
  // Phase 2 / 2-R9 — project scope: prefer a record scoped to this project, fall back to a global
  // (project_id === null) one. Keeps existing global accounts/merchants working unchanged.
  const account = normalizedAccountLogin
    ? pickProjectScoped(state.accounts, (item) => item.login === normalizedAccountLogin, selection.project_id)
    : null;
  const merchant = normalizedMerchantName
    ? pickProjectScoped(state.merchants, (item) => item.name === normalizedMerchantName, selection.project_id)
    : null;
  const merchantAdmin = merchant?.admin_login
    ? pickProjectScoped(state.accounts, (item) => item.login === merchant.admin_login, selection.project_id)
    : null;
  const resolvedAccount = account ?? merchantAdmin;

  if (normalizedAccountLogin && !account && !(explicitUsername || explicitPassword || explicitTwoFactorOtp)) {
    throw new Error(`Server account not found: ${normalizedAccountLogin}`);
  }
  if (normalizedMerchantName && !merchant && !explicitMerchant) {
    throw new Error(`Server merchant not found: ${normalizedMerchantName}`);
  }

  // Phase 2 / 2.M3-2.M4 — per-project server_* defaults are the final fallback after an
  // explicit run value and the selected account/merchant.
  const projectVars = selection.project_id
    ? state.project_server_vars.find((v) => v.project_id === selection.project_id) ?? null
    : null;

  return {
    account: resolvedAccount,
    merchant,
    server_username: explicitUsername || resolvedAccount?.login || projectVars?.server_username || "",
    // Stored stand-credential secrets may be encrypted at rest (Phase 2 / 2.2); openSecret
    // decrypts when a KEK is set and passes plaintext through otherwise.
    server_password: explicitPassword || openSecret(resolvedAccount?.password) || openSecret(projectVars?.server_password) || "",
    server_2faotp: explicitTwoFactorOtp || openSecret(resolvedAccount?.["2fa_otp"]) || openSecret(projectVars?.server_2faotp) || "",
    server_merchant: explicitMerchant || merchant?.name || projectVars?.server_merchant || "",
    extra: resolveExtraServerVars(projectVars?.extra)
  };
}

// Phase 2 / 2-R10 — collect arbitrary project-scoped server_* tokens. Keys colliding with the
// four standard server_* names are dropped: those are resolved (with account/merchant fallback)
// by resolveServerValueTemplate, so the standard handling always wins.
function resolveExtraServerVars(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) {
    return {};
  }
  const reserved = new Set<string>(SERVER_INPUT_NAMES);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    const name = String(key ?? "").trim();
    if (!name || reserved.has(name)) {
      continue;
    }
    result[name] = String(value ?? "");
  }
  return result;
}

// Phase 3 — masked preview of what {server_*} placeholders would resolve to for a given selection,
// so the RunWizard can show the user the effective values before launching. Secrets (password, 2FA)
// are never returned — only whether they are available.
export interface ServerBindingsPreview {
  server_username: string;
  has_password: boolean;
  has_2faotp: boolean;
  server_merchant: string;
  extra: Record<string, string>;
}

export function previewServerBindings(
  state: AppState,
  selection: {
    project_id?: string;
    account_login?: string;
    merchant_name?: string;
    server_username?: string;
    server_password?: string;
    server_2faotp?: string;
    server_merchant?: string;
  }
): ServerBindingsPreview {
  const base = resolveSelectedBaseData(state, selection);
  return {
    server_username: base.server_username,
    has_password: Boolean(base.server_password),
    has_2faotp: Boolean(base.server_2faotp),
    server_merchant: base.server_merchant,
    extra: base.extra
  };
}

function buildServerInputBindings(selectedBaseData: SelectedBaseData): ServerInputBindings {
  const inputs: Record<string, string> = {};
  const otpSecrets: Record<string, string> = {};

  if (selectedBaseData.server_username) {
    inputs[SERVER_USERNAME_INPUT_NAME] = selectedBaseData.server_username;
  }
  if (selectedBaseData.server_password) {
    inputs[SERVER_PASSWORD_INPUT_NAME] = selectedBaseData.server_password;
  }
  if (selectedBaseData.server_2faotp) {
    const accountOtpSecret = tryNormalizeTotpSecret(selectedBaseData.server_2faotp);
    if (accountOtpSecret) {
      otpSecrets[SERVER_2FA_OTP_INPUT_NAME] = accountOtpSecret;
    } else {
      inputs[SERVER_2FA_OTP_INPUT_NAME] = selectedBaseData.server_2faotp;
    }
  }
  if (selectedBaseData.server_merchant) {
    inputs[SERVER_MERCHANT_INPUT_NAME] = selectedBaseData.server_merchant;
  }

  return { inputs, otp_secrets: otpSecrets };
}

function resolveServerTemplatesInInputs(
  providedInputs: Record<string, string>,
  selectedBaseData: SelectedBaseData
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(providedInputs).map(([name, value]) => [name, resolveServerValueTemplate(String(value ?? ""), selectedBaseData)])
  );
}

function resolveServerValueTemplate(value: string, selectedBaseData: SelectedBaseData): string {
  let resolved = String(value ?? "");

  if (resolved.includes(SERVER_INPUT_TOKENS.username)) {
    if (!selectedBaseData.server_username) {
      throw new Error(`Set server username or choose a server account to use ${SERVER_INPUT_TOKENS.username}`);
    }
    resolved = resolved.replaceAll(SERVER_INPUT_TOKENS.username, selectedBaseData.server_username);
  }
  if (resolved.includes(SERVER_INPUT_TOKENS.password)) {
    if (!selectedBaseData.server_password) {
      throw new Error(`Set server password or choose a server account to use ${SERVER_INPUT_TOKENS.password}`);
    }
    resolved = resolved.replaceAll(SERVER_INPUT_TOKENS.password, selectedBaseData.server_password);
  }
  if (resolved.includes(SERVER_INPUT_TOKENS.two_factor_otp)) {
    if (!selectedBaseData.server_2faotp) {
      throw new Error(`Set server 2FA/TOTP or choose a server account to use ${SERVER_INPUT_TOKENS.two_factor_otp}`);
    }
    resolved = resolved.replaceAll(SERVER_INPUT_TOKENS.two_factor_otp, selectedBaseData.server_2faotp);
  }
  if (resolved.includes(SERVER_INPUT_TOKENS.merchant)) {
    if (!selectedBaseData.server_merchant) {
      throw new Error(`Set server merchant or choose a server merchant preset to use ${SERVER_INPUT_TOKENS.merchant}`);
    }
    resolved = resolved.replaceAll(SERVER_INPUT_TOKENS.merchant, selectedBaseData.server_merchant);
  }

  // Phase 2 / 2-R10 — substitute any extra project-scoped server_* tokens. Only exact {key}
  // matches for declared keys are replaced; unknown {…} placeholders are left untouched.
  for (const [key, value] of Object.entries(selectedBaseData.extra)) {
    const token = `{${key}}`;
    if (!resolved.includes(token)) {
      continue;
    }
    if (!value) {
      throw new Error(`Set server variable ${key} in the project defaults to use ${token}`);
    }
    resolved = resolved.replaceAll(token, value);
  }

  return resolved;
}

function containsServerInputToken(value: string): boolean {
  return Object.values(SERVER_INPUT_TOKENS).some((token) => String(value ?? "").includes(token));
}

function tryNormalizeTotpSecret(value: unknown): string {
  const text = normalizeOtpLogin(value);
  if (!text) {
    return "";
  }
  try {
    return normalizeTotpSecret(text);
  } catch {
    return "";
  }
}

function normalizeNonSecretServerValue(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSecretServerValue(value: unknown): string {
  const text = String(value ?? "");
  return text.trim() ? text : "";
}

function normalizeStoredServerValue(value: string): string | null {
  return value ? value : null;
}

function uniqueFolderPaths(folderPaths: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const folderPath of folderPaths) {
    const normalized = normalizeFolderPath(folderPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function uniqueScenarioIds(scenarioIds: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const scenarioId of scenarioIds) {
    const normalized = String(scenarioId || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function normalizeExecutionStage(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 1;
  }
  return Math.max(1, Math.trunc(value));
}

function normalizePositiveInt(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 1;
  }
  return Math.max(1, Math.trunc(value));
}

function normalizeRunIteration(value: number | undefined, amountTimesToRun: number): number {
  const iteration = normalizePositiveInt(value);
  return Math.min(iteration, amountTimesToRun);
}

function normalizeParallelBatchSize(value: number | undefined, amountTimesToRun: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return amountTimesToRun;
  }
  return Math.min(Math.max(1, Math.trunc(value)), amountTimesToRun);
}

function normalizeDefaultTimeoutMs(value: number | undefined): number | null {
  if (!Number.isFinite(value) || !value || value < 1) {
    return null;
  }
  return Math.max(1, Math.trunc(value));
}

function supportsAutomaticInputValue(spec: InputSpec): boolean {
  return spec.type !== "2fa_otp";
}

function resolveAutomaticInputTemplate(template: string, inputName: string, scenario: ScenarioRecord): string {
  const folderParts = normalizeFolderPath(scenario.folder_path).split("/").filter(Boolean);
  const normalizedInputName = slugifyAutoPart(inputName);
  const folderName = slugifyTracePart(folderParts[folderParts.length - 1] ?? "root");
  const scenarioName = slugifyTracePart(scenario.name || scenario.slug || scenario.id);
  const uniqueNumber = createUniqueNumberSuffix();
  const increment = template.includes("{increment}") ? nextAutomaticInputIncrement() : "";
  // Generation helpers usable in ANY input: {random} (random number), {uuid}, {date} (YYYYMMDD).
  // {datetime} is intentionally NOT resolved here — the runner fills it at container run time.
  const random = template.includes("{random}") ? randomNumberString() : "";
  const uuid = template.includes("{uuid}") ? randomUUID() : "";
  const date = template.includes("{date}") ? new Date().toISOString().slice(0, 10).replaceAll("-", "") : "";

  return String(template)
    .replaceAll("{input_name}", normalizedInputName)
    .replaceAll("{folder_name}", folderName)
    .replaceAll("{scenario_name}", scenarioName)
    .replaceAll("{increment}", increment)
    .replaceAll("{uniq_number}", uniqueNumber)
    .replaceAll("{uniq_name}", uniqueNumber)
    .replaceAll("{uniq_namer}", uniqueNumber)
    .replaceAll("{random}", random)
    .replaceAll("{uuid}", uuid)
    .replaceAll("{date}", date);
}

function randomNumberString(): string {
  // 9-digit random number from crypto bytes (no Math.random).
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000_000).padStart(9, "0");
}

function resolvePoolTemplate(template: string, inputName: string, scenario: ScenarioRecord): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return resolveAutomaticInputTemplate(template || defaultTraceTemplate(), inputName, scenario)
    .replaceAll("{date}", date)
    .replaceAll("{testName}", slugifyTracePart(scenario.name || scenario.slug || scenario.id))
    .replaceAll("{runId}", createUniqueNumberSuffix())
    .replaceAll("{seq}", createUniqueNumberSuffix());
}

function defaultTraceTemplate(): string {
  return "{date}_{testName}_{seq}";
}

function isTraceInputName(value: string): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized === "trace" || normalized === "traceid" || normalized === "traceidentifier";
}

function slugifyTracePart(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "root";
}

function slugifyAutoPart(value: string): string {
  return slugifyTracePart(value);
}

function createUniqueNumberSuffix(): string {
  const hex = randomUUID().replaceAll("-", "").slice(0, 12);
  return Number.parseInt(hex, 16).toString().padStart(15, "0");
}

function nextAutomaticInputIncrement(): string {
  automaticInputIncrement += 1;
  return String(automaticInputIncrement);
}

function compareScenarios(left: ScenarioRecord, right: ScenarioRecord): number {
  return (
    left.folder_path.localeCompare(right.folder_path) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function createQueuedRunLogEntry(triggeredAt: string, executionStage: number): RunLogEntry {
  return {
    timestamp: triggeredAt,
    level: "info",
    message:
      executionStage > 1
        ? `Run queued in stage ${executionStage}. It will start after earlier stages finish.`
        : "Run queued. Waiting to start Docker execution."
  };
}
