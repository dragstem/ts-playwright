import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  AppStateSchema,
  METADATA_FILE_NAME,
  ScenarioMetadataSchema,
  normalizeInputSpecs,
  type AppState,
  type AccountRecord,
  type EnvironmentRecord,
  type MerchantRecord,
  type PoolItemRecord,
  type PoolRecord,
  type ProjectRecord,
  type ScenarioRecord
} from "@ts-playwright/shared";
import type { SeedAccountConfig, SeedMerchantConfig, SeedPoolConfig, SeedPoolItemConfig } from "./config";

export interface SeedStateEntities {
  accounts?: SeedAccountConfig[];
  merchants?: SeedMerchantConfig[];
  pools?: SeedPoolConfig[];
  pool_items?: SeedPoolItemConfig[];
}

// The persistence surface app.ts depends on. JsonStateStore is the default; SqliteStateStore is the
// opt-in alternative (2-R1). Both hydrate scenarios from disk packages, so only this shape differs.
export interface StateStore {
  readState(): AppState;
  update<T>(mutate: (state: AppState) => T): T;
}

export class JsonStateStore implements StateStore {
  private readonly entitiesDir: string;
  private readonly accountsFile: string;
  private readonly merchantsFile: string;
  private readonly poolsFile: string;
  private readonly poolItemsFile: string;

  constructor(
    private readonly stateFile: string,
    private readonly seedEntities: SeedStateEntities = {}
  ) {
    this.entitiesDir = path.dirname(stateFile);
    this.accountsFile = path.join(this.entitiesDir, "accounts.json");
    this.merchantsFile = path.join(this.entitiesDir, "merchants.json");
    this.poolsFile = path.join(this.entitiesDir, "pools.json");
    this.poolItemsFile = path.join(this.entitiesDir, "pool-items.json");
    mkdirSync(this.entitiesDir, { recursive: true });
    if (!existsSync(stateFile)) {
      this.writeState(createSeedState(this.seedEntities));
    } else {
      const parsed = this.readState();
      this.writeState(applySeedEntities(parsed, this.seedEntities));
    }
  }

  readState(): AppState {
    const raw = stripJsonBom(readFileSync(this.stateFile, "utf8"));
    const parsed = AppStateSchema.parse(migrateLegacyOtpState(JSON.parse(raw)));
    const merged = mergeTrackedEntities(parsed, {
      accounts: readTrackedEntities(this.accountsFile, "accounts"),
      merchants: readTrackedEntities(this.merchantsFile, "merchants"),
      pools: readTrackedEntities(this.poolsFile, "pools"),
      pool_items: readTrackedEntities(this.poolItemsFile, "pool_items")
    });
    return hydrateStateFromStorage(this.entitiesDir, merged);
  }

  writeState(state: AppState): void {
    const normalized = AppStateSchema.parse(state);
    writeFileSync(this.stateFile, JSON.stringify(normalized, null, 2), "utf8");
    writeFileSync(this.accountsFile, JSON.stringify(normalized.accounts, null, 2), "utf8");
    writeFileSync(this.merchantsFile, JSON.stringify(normalized.merchants, null, 2), "utf8");
    writeFileSync(this.poolsFile, JSON.stringify(normalized.pools, null, 2), "utf8");
    writeFileSync(this.poolItemsFile, JSON.stringify(normalized.pool_items, null, 2), "utf8");
  }

  update<T>(mutate: (state: AppState) => T): T {
    const state = this.readState();
    const result = mutate(state);
    this.writeState(state);
    return result;
  }
}

function stripJsonBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function createSeedState(seedEntities: SeedStateEntities = {}): AppState {
  const now = new Date().toISOString();
  const projects: ProjectRecord[] = [
    {
      id: "proj_demo",
      name: "Demo Project",
      description: "Sample project"
    }
  ];
  const environments: EnvironmentRecord[] = [
    {
      id: "staging",
      project_id: "proj_demo",
      name: "staging",
      base_url: "https://google.com",
      is_default: true
    }
  ];
  const accounts: AccountRecord[] = (seedEntities.accounts ?? []).map((item) => ({
    login: item.login,
    password: item.password,
    "2fa_otp": item["2fa_otp"],
    project_id: null,
    created_at: now,
    updated_at: now
  }));
  const merchants: MerchantRecord[] = (seedEntities.merchants ?? []).map((item) => ({
    name: item.name,
    admin_login: item.admin_login ?? null,
    env_ids: item.env_ids ?? [],
    project_id: null,
    created_at: now,
    updated_at: now
  }));
  const pools: PoolRecord[] = (seedEntities.pools ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    project_id: item.project_id ?? null,
    env_ids: item.env_ids ?? [],
    dedupe: item.dedupe ?? true,
    allocation_strategy: item.allocation_strategy ?? "manual",
    template: item.template ?? "",
    fetch_scenario_id: item.fetch_scenario_id ?? null,
    fetch_input_name: item.fetch_input_name ?? "addresses_json",
    fetch_output_key: item.fetch_output_key ?? "address_info",
    auto_import_enabled: item.auto_import_enabled ?? false,
    auto_import_scenario_id: item.auto_import_scenario_id ?? null,
    auto_import_output_key: item.auto_import_output_key ?? "",
    auto_import_mode: item.auto_import_mode ?? "whole",
    auto_import_json_path: item.auto_import_json_path ?? "",
    created_at: now,
    updated_at: now
  }));
  const poolItems: PoolItemRecord[] = (seedEntities.pool_items ?? []).map((item) => ({
    id: item.id,
    pool_id: item.pool_id,
    value: item.value,
    label: item.label ?? "",
    enabled: item.enabled ?? true,
    currency: item.currency ?? "",
    network: item.network ?? "",
    metadata: item.metadata ?? {},
    source: item.source ?? { type: "manual" },
    created_at: now,
    updated_at: now,
    last_fetched_at: null,
    last_fetch_status: null
  }));

  return AppStateSchema.parse({
    projects,
    environments,
    accounts,
    merchants,
    pools,
    pool_items: poolItems,
    scenarios: [],
    runs: []
  });
}

function readTrackedEntities(
  filePath: string,
  entityType: "accounts" | "merchants" | "pools" | "pool_items"
): unknown[] | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeTrackedEntities(
  state: AppState,
  tracked: {
    accounts: unknown[] | null;
    merchants: unknown[] | null;
    pools: unknown[] | null;
    pool_items: unknown[] | null;
  }
): AppState {
  const nextState = {
    ...state,
    accounts: tracked.accounts ?? state.accounts,
    merchants: tracked.merchants ?? state.merchants,
    pools: tracked.pools ?? state.pools,
    pool_items: tracked.pool_items ?? state.pool_items
  };
  return AppStateSchema.parse(migrateLegacyOtpState(nextState));
}

export function applySeedEntities(state: AppState, seedEntities: SeedStateEntities = {}): AppState {
  const now = new Date().toISOString();

  for (const seed of seedEntities.accounts ?? []) {
    if (state.accounts.some((item) => item.login === seed.login)) {
      continue;
    }
    state.accounts.push({
      login: seed.login,
      password: seed.password,
      "2fa_otp": seed["2fa_otp"],
      project_id: null,
      created_at: now,
      updated_at: now
    });
  }

  for (const seed of seedEntities.merchants ?? []) {
    if (state.merchants.some((item) => item.name === seed.name)) {
      continue;
    }
    state.merchants.push({
      name: seed.name,
      admin_login: seed.admin_login ?? null,
      env_ids: seed.env_ids ?? [],
      project_id: null,
      created_at: now,
      updated_at: now
    });
  }

  for (const seed of seedEntities.pools ?? []) {
    if (state.pools.some((item) => item.id === seed.id)) {
      continue;
    }
    state.pools.push({
      id: seed.id,
      name: seed.name,
      kind: seed.kind,
      project_id: seed.project_id ?? null,
      env_ids: seed.env_ids ?? [],
      dedupe: seed.dedupe ?? true,
      allocation_strategy: seed.allocation_strategy ?? "manual",
      template: seed.template ?? "",
      fetch_scenario_id: seed.fetch_scenario_id ?? null,
      fetch_input_name: seed.fetch_input_name ?? "addresses_json",
      fetch_output_key: seed.fetch_output_key ?? "address_info",
      auto_import_enabled: seed.auto_import_enabled ?? false,
      auto_import_scenario_id: seed.auto_import_scenario_id ?? null,
      auto_import_output_key: seed.auto_import_output_key ?? "",
      auto_import_mode: seed.auto_import_mode ?? "whole",
      auto_import_json_path: seed.auto_import_json_path ?? "",
      created_at: now,
      updated_at: now
    });
  }

  for (const seed of seedEntities.pool_items ?? []) {
    if (state.pool_items.some((item) => item.id === seed.id)) {
      continue;
    }
    state.pool_items.push({
      id: seed.id,
      pool_id: seed.pool_id,
      value: seed.value,
      label: seed.label ?? "",
      enabled: seed.enabled ?? true,
      currency: seed.currency ?? "",
      network: seed.network ?? "",
      metadata: seed.metadata ?? {},
      source: seed.source ?? { type: "manual" },
      created_at: now,
      updated_at: now,
      last_fetched_at: null,
      last_fetch_status: null
    });
  }

  return state;
}

function migrateLegacyOtpState(rawState: unknown): unknown {
  if (!rawState || typeof rawState !== "object") {
    return rawState;
  }

  const state = rawState as Record<string, unknown>;
  const legacyOtpSecrets = buildLegacyOtpSecretMap(state.otp_accounts);
  if (legacyOtpSecrets.size === 0) {
    return state;
  }

  migrateLegacyAccounts(state.accounts, legacyOtpSecrets);
  migrateLegacyScenarios(state.scenarios, legacyOtpSecrets);
  migrateLegacyRuns(state.runs, legacyOtpSecrets);
  delete state.otp_accounts;
  return state;
}

function buildLegacyOtpSecretMap(value: unknown): Map<string, string> {
  const results = new Map<string, string>();
  if (!Array.isArray(value)) {
    return results;
  }
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const login = String(record.login ?? "").trim();
    const secret = String(record.secret ?? "").trim();
    if (!login || !secret) {
      continue;
    }
    results.set(login, secret);
  }
  return results;
}

function migrateLegacyAccounts(accounts: unknown, legacyOtpSecrets: Map<string, string>): void {
  if (!Array.isArray(accounts)) {
    return;
  }
  for (const item of accounts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const account = item as Record<string, unknown>;
    const otpValue = String(account["2fa_otp"] ?? "").trim();
    if (!otpValue) {
      continue;
    }
    const migrated = legacyOtpSecrets.get(otpValue);
    if (migrated) {
      account["2fa_otp"] = migrated;
    }
  }
}

function migrateLegacyScenarios(scenarios: unknown, legacyOtpSecrets: Map<string, string>): void {
  if (!Array.isArray(scenarios)) {
    return;
  }
  for (const item of scenarios) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const scenario = item as Record<string, unknown>;
    const inputs = Array.isArray(scenario.inputs) ? scenario.inputs : [];
    for (const rawInput of inputs) {
      if (!rawInput || typeof rawInput !== "object") {
        continue;
      }
      const input = rawInput as Record<string, unknown>;
      if (String(input.type ?? "") !== "2fa_otp") {
        continue;
      }
      const otpValue = String(input.otp_login ?? "").trim();
      const migrated = legacyOtpSecrets.get(otpValue);
      if (migrated) {
        input.otp_login = migrated;
      }
    }
  }
}

function migrateLegacyRuns(runs: unknown, legacyOtpSecrets: Map<string, string>): void {
  if (!Array.isArray(runs)) {
    return;
  }
  for (const item of runs) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const run = item as Record<string, unknown>;
    if (!run.inputs || typeof run.inputs !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(run.inputs as Record<string, unknown>)) {
      const text = String(value ?? "").trim();
      if (!text.startsWith("otp:")) {
        continue;
      }
      const migrated = legacyOtpSecrets.get(text.slice(4));
      if (migrated) {
        (run.inputs as Record<string, unknown>)[key] = migrated;
      }
    }
  }
}

export function hydrateStateFromStorage(storageDir: string, state: AppState): AppState {
  const discovered = discoverScenariosFromStorage(storageDir);
  if (discovered.length === 0) {
    return state;
  }

  const existingByPackage = new Map(
    state.scenarios.map((scenario) => [path.resolve(scenario.package_path), scenario] as const)
  );

  for (const scenario of discovered) {
    const key = path.resolve(scenario.package_path);
    const existing = existingByPackage.get(key);
    if (existing) {
      existing.project_id = scenario.project_id;
      existing.env_id = scenario.env_id;
      existing.name = scenario.name;
      existing.slug = scenario.slug;
      existing.folder_path = scenario.folder_path;
      existing.created_by = scenario.created_by;
      existing.created_at = scenario.created_at;
      existing.status = scenario.status;
      existing.inputs = scenario.inputs;
      continue;
    }
    state.scenarios.push(scenario);
    existingByPackage.set(key, scenario);
  }

  return state;
}

function discoverScenariosFromStorage(storageDir: string): ScenarioRecord[] {
  const projectsRoot = path.join(storageDir, "projects");
  if (!existsSync(projectsRoot)) {
    return [];
  }

  const scenarios: ScenarioRecord[] = [];
  const projectIds = readdirSync(projectsRoot).sort((left, right) => left.localeCompare(right));
  for (const projectId of projectIds) {
    const projectRoot = path.join(projectsRoot, projectId);
    if (!statSafe(projectRoot)?.isDirectory()) {
      continue;
    }
    walkProjectTree(projectRoot, projectId, projectRoot, scenarios);
  }
  return scenarios;
}

function walkProjectTree(
  currentDir: string,
  projectId: string,
  projectRoot: string,
  scenarios: ScenarioRecord[]
): void {
  const packagePath = path.join(currentDir, "package.zip");
  if (existsSync(packagePath)) {
    const scenario = readScenarioFromPackage(projectId, projectRoot, currentDir, packagePath);
    if (scenario) {
      scenarios.push(scenario);
    }
    return;
  }

  const items = readdirSync(currentDir).sort((left, right) => left.localeCompare(right));
  for (const item of items) {
    const target = path.join(currentDir, item);
    if (!statSafe(target)?.isDirectory()) {
      continue;
    }
    walkProjectTree(target, projectId, projectRoot, scenarios);
  }
}

// A scenario's package.zip is immutable once recorded, so unzipping + parsing its metadata on every
// readState() (there can be hundreds of packages) was the dominant source of latency. Cache the derived
// record keyed by absolute path + file mtime; re-recording rewrites the zip → mtime changes → the entry
// is naturally invalidated. Callers get a clone so hydrate's field mutation can't poison the cache.
const scenarioPackageCache = new Map<string, { mtimeMs: number; record: ScenarioRecord }>();

function readScenarioFromPackage(
  projectId: string,
  projectRoot: string,
  scenarioDir: string,
  packagePath: string
): ScenarioRecord | null {
  try {
    const cacheKey = path.resolve(packagePath);
    const mtimeMs = statSync(packagePath).mtimeMs;
    const cached = scenarioPackageCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) {
      return structuredClone(cached.record);
    }

    const zip = new AdmZip(packagePath);
    const entry = zip.getEntry(METADATA_FILE_NAME);
    if (!entry) {
      return null;
    }
    const metadata = ScenarioMetadataSchema.parse(JSON.parse(entry.getData().toString("utf8")));
    const relativeScenarioDir = path.relative(projectRoot, scenarioDir).replaceAll("\\", "/");
    const derivedFolderPath = path.dirname(relativeScenarioDir).replaceAll("\\", "/");
    const folderPath = derivedFolderPath === "." ? "" : derivedFolderPath;

    const record: ScenarioRecord = {
      id: buildStableScenarioId(projectId, relativeScenarioDir),
      project_id: projectId,
      env_id: metadata.env_id,
      name: metadata.scenario_name,
      slug: metadata.scenario_slug,
      folder_path: folderPath,
      created_by: metadata.recorded_by,
      created_at: metadata.recorded_at,
      package_path: packagePath,
      status: "active",
      inputs: normalizeInputSpecs(metadata.inputs)
    };
    scenarioPackageCache.set(cacheKey, { mtimeMs, record });
    return structuredClone(record);
  } catch {
    return null;
  }
}

function buildStableScenarioId(projectId: string, relativeScenarioDir: string): string {
  const digest = createHash("sha1").update(`${projectId}:${relativeScenarioDir}`).digest("hex").slice(0, 16);
  return `scenario_${digest}`;
}

function statSafe(targetPath: string) {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}
