import path from "node:path";
import { ensureStorageLayout, normalizeTotpSecret } from "@ts-playwright/shared";

export interface SeedAccountConfig {
  login: string;
  password: string;
  "2fa_otp": string;
}

export interface SeedMerchantConfig {
  name: string;
  admin_login: string | null;
  env_ids: string[];
}

export interface SeedPoolConfig {
  id: string;
  name: string;
  kind: "deposit_address" | "payout_address" | "trace_id" | "custom";
  project_id: string | null;
  env_ids: string[];
  dedupe: boolean;
  allocation_strategy: "manual" | "first_enabled" | "round_robin" | "random" | "template";
  template: string;
  fetch_scenario_id: string | null;
  fetch_input_name: string;
  fetch_output_key: string;
  auto_import_enabled: boolean;
  auto_import_scenario_id: string | null;
  auto_import_output_key: string;
  auto_import_mode: "whole" | "array_items";
  auto_import_json_path: string;
}

export interface SeedPoolItemConfig {
  id: string;
  pool_id: string;
  value: string;
  label: string;
  enabled: boolean;
  currency: string;
  network: string;
  metadata: Record<string, unknown>;
  source: {
    type: "manual" | "run_output" | "fetch_scenario";
    run_id?: string;
    scenario_id?: string;
    output_key?: string;
  };
}

export interface ServerConfig {
  root_dir: string;
  storage_dir: string;
  state_file: string;
  // Phase 2 / 2-R1 — which state backend to use. "json" (default) or "sqlite" (opt-in, node:sqlite).
  state_backend: "json" | "sqlite";
  api_key: string | null;
  require_auth: boolean;
  host: string;
  port: number;
  otp_autoreplace: boolean;
  docker_image: string | null;
  docker_shm_size: string | null;
  docker_ipc: string | null;
  docker_network: string | null;
  docker_add_hosts: string[];
  docker_cpus: string | null;
  docker_memory: string | null;
  docker_pids_limit: number | null;
  docker_cap_drop: string | null;
  docker_no_new_privileges: boolean;
  docker_workspace_transport: "auto" | "bind" | "copy";
  docker_runner_mode: "npx" | "global";
  max_concurrent_runs: number;
  run_timeout_ms: number;
  playwright_default_timeout_ms: number | null;
  seed_accounts: SeedAccountConfig[];
  seed_merchants: SeedMerchantConfig[];
  seed_pools: SeedPoolConfig[];
  seed_pool_items: SeedPoolItemConfig[];
}

export function loadConfig(): ServerConfig {
  const rootDir = path.resolve(__dirname, "../../..");
  const storageDir = process.env.APP_STORAGE_DIR
    ? path.resolve(process.env.APP_STORAGE_DIR)
    : path.join(rootDir, "storage");
  ensureStorageLayout(storageDir);
  const legacyOtpSecrets = parseLegacySeedOtpAccounts(process.env.APP_OTP_ACCOUNTS_JSON);
  const apiKeyRaw = String(process.env.APP_API_KEY ?? "").trim();
  const apiKey = apiKeyRaw || null;
  validateApiKeyRequirement(apiKey);
  return {
    root_dir: rootDir,
    storage_dir: storageDir,
    state_file: path.join(storageDir, "app-state.json"),
    state_backend: String(process.env.APP_STATE_BACKEND ?? "").trim().toLowerCase() === "sqlite" ? "sqlite" : "json",
    api_key: apiKey,
    // Phase 3 / L3 — global RBAC. Secure by default: every /api route (except login/register)
    // requires a session cookie, PAT bearer, or the machine x-api-key. Set APP_REQUIRE_AUTH=0 to
    // open the data plane (local dev / test harness only).
    require_auth: parseBooleanFlag(process.env.APP_REQUIRE_AUTH, true),
    host: process.env.APP_HOST ?? "0.0.0.0",
    port: Number(process.env.APP_PORT ?? 8000),
    otp_autoreplace: ["1", "true", "yes"].includes(String(process.env.APP_OTP_AUTOREPLACE ?? "").toLowerCase()),
    docker_image: String(process.env.APP_DOCKER_IMAGE ?? "").trim() || null,
    docker_shm_size: normalizeOptionalText(process.env.APP_DOCKER_SHM_SIZE, "1g"),
    docker_ipc: normalizeOptionalText(process.env.APP_DOCKER_IPC),
    docker_network: normalizeOptionalText(process.env.APP_DOCKER_NETWORK),
    docker_add_hosts: parseCsv(process.env.APP_DOCKER_ADD_HOSTS),
    docker_cpus: normalizeOptionalText(process.env.APP_DOCKER_CPUS),
    docker_memory: normalizeOptionalText(process.env.APP_DOCKER_MEMORY),
    docker_pids_limit: normalizePositiveInteger(process.env.APP_DOCKER_PIDS_LIMIT) ?? 512,
    docker_cap_drop: normalizeOptionalText(process.env.APP_DOCKER_CAP_DROP, "ALL"),
    docker_no_new_privileges: parseBooleanFlag(process.env.APP_DOCKER_NO_NEW_PRIVILEGES, false),
    docker_workspace_transport: parseWorkspaceTransport(process.env.APP_DOCKER_WORKSPACE_TRANSPORT),
    docker_runner_mode: parseDockerRunnerMode(process.env.APP_DOCKER_RUNNER_MODE),
    max_concurrent_runs: normalizePositiveInteger(process.env.APP_MAX_CONCURRENT_RUNS) ?? 2,
    run_timeout_ms: Number(process.env.APP_RUN_TIMEOUT_MS ?? 15 * 60 * 1000),
    playwright_default_timeout_ms: normalizePositiveInteger(process.env.APP_PLAYWRIGHT_DEFAULT_TIMEOUT_MS),
    seed_accounts: parseSeedAccounts(process.env.APP_ACCOUNTS_JSON, legacyOtpSecrets),
    seed_merchants: parseSeedMerchants(process.env.APP_MERCHANTS_JSON),
    seed_pools: parseSeedPools(process.env.APP_POOLS_JSON),
    seed_pool_items: parseSeedPoolItems(process.env.APP_POOL_ITEMS_JSON)
  };
}

function normalizeOptionalText(value: string | undefined, fallback = ""): string | null {
  const text = String(value ?? fallback).trim();
  if (!text || ["0", "false", "none", "off"].includes(text.toLowerCase())) {
    return null;
  }
  return text;
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWorkspaceTransport(value: string | undefined): "auto" | "bind" | "copy" {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "bind" || text === "copy" ? text : "auto";
}

function parseDockerRunnerMode(value: string | undefined): "npx" | "global" {
  return String(value ?? "").trim().toLowerCase() === "global" ? "global" : "npx";
}

function normalizePositiveInteger(value: string | undefined): number | null {
  const parsed = Number(value ?? "");
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return fallback;
}

let apiKeyWarningShown = false;

// Phase 0 / P0-T04: fail fast when /api would be left unprotected in production.
// The key guards only /api routes; HTML pages stay open until real auth (Phase 2).
// APP_REQUIRE_API_KEY forces (1/true) or disables (0/false) the requirement; otherwise
// NODE_ENV=production implies it. Exported for unit testing.
export function validateApiKeyRequirement(apiKey: string | null): void {
  if (apiKey && apiKey.trim()) {
    return;
  }
  const flag = String(process.env.APP_REQUIRE_API_KEY ?? "").trim().toLowerCase();
  const explicitlyDisabled = ["0", "false", "no", "off"].includes(flag);
  const explicitlyRequired = ["1", "true", "yes", "on"].includes(flag);
  const required = explicitlyDisabled ? false : explicitlyRequired || process.env.NODE_ENV === "production";
  if (required) {
    throw new Error(
      "APP_API_KEY is required in production. Set APP_API_KEY to protect /api, or set APP_REQUIRE_API_KEY=0 to explicitly allow an unprotected /api. Note: the key guards only /api routes; HTML pages remain open until real authentication (Phase 2)."
    );
  }
  if (!apiKeyWarningShown) {
    apiKeyWarningShown = true;
    console.warn("[ts-playwright] APP_API_KEY is not set — /api is unprotected. This is acceptable for local development only.");
  }
}

function parseLegacySeedOtpAccounts(rawValue: string | undefined): Record<string, string> {
  return Object.fromEntries(
    parseJsonArray(rawValue)
      .map((item) => {
        const login = normalizeText(item.login);
        const secret = normalizeConfiguredOtpSecret(item.secret);
        return [login, secret] as const;
      })
      .filter(([login, secret]) => login && secret)
  );
}

function parseSeedAccounts(rawValue: string | undefined, legacyOtpSecrets: Record<string, string>): SeedAccountConfig[] {
  return parseJsonArray(rawValue)
    .map((item) => ({
      login: normalizeText(item.login),
      password: normalizeText(item.password),
      "2fa_otp": resolveSeedAccountOtpSecret(item["2fa_otp"], legacyOtpSecrets)
    }))
    .filter((item) => item.login && item.password);
}

function parseSeedMerchants(rawValue: string | undefined): SeedMerchantConfig[] {
  return parseJsonArray(rawValue)
    .map((item) => ({
      name: normalizeText(item.name),
      admin_login: normalizeText(item.admin_login) || null,
      env_ids: parseTextList(item.env_ids)
    }))
    .filter((item) => item.name);
}

function parseSeedPools(rawValue: string | undefined): SeedPoolConfig[] {
  return parseJsonArray(rawValue)
    .map((item) => {
      const id = normalizeText(item.id) || slugifyConfigId(normalizeText(item.name));
      return {
        id,
        name: normalizeText(item.name) || id,
        kind: parsePoolKind(item.kind),
        project_id: normalizeText(item.project_id) || null,
        env_ids: parseTextList(item.env_ids),
        dedupe: parseOptionalBoolean(item.dedupe, true),
        allocation_strategy: parsePoolAllocationStrategy(item.allocation_strategy),
        template: normalizeText(item.template),
        fetch_scenario_id: normalizeText(item.fetch_scenario_id) || null,
        fetch_input_name: normalizeText(item.fetch_input_name) || "addresses_json",
        fetch_output_key: normalizeText(item.fetch_output_key) || "address_info",
        auto_import_enabled: parseOptionalBoolean(item.auto_import_enabled, false),
        auto_import_scenario_id: normalizeText(item.auto_import_scenario_id) || null,
        auto_import_output_key: normalizeText(item.auto_import_output_key),
        auto_import_mode: parseImportMode(item.auto_import_mode),
        auto_import_json_path: normalizeText(item.auto_import_json_path)
      };
    })
    .filter((item) => item.id && item.name);
}

function parseSeedPoolItems(rawValue: string | undefined): SeedPoolItemConfig[] {
  return parseJsonArray(rawValue)
    .map((item) => {
      const value = normalizeText(item.value);
      const poolId = normalizeText(item.pool_id);
      const id = normalizeText(item.id) || `${poolId}_${slugifyConfigId(value).slice(0, 48)}`;
      return {
        id,
        pool_id: poolId,
        value,
        label: normalizeText(item.label),
        enabled: parseOptionalBoolean(item.enabled, true),
        currency: normalizeText(item.currency),
        network: normalizeText(item.network),
        metadata: parseRecord(item.metadata),
        source: parsePoolSource(item.source)
      };
    })
    .filter((item) => item.id && item.pool_id && item.value);
}

function parseJsonArray(rawValue: string | undefined): Array<Record<string, unknown>> {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array in server config env value");
  }
  return parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function parseTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parsePoolKind(value: unknown): SeedPoolConfig["kind"] {
  const text = normalizeText(value);
  return text === "deposit_address" || text === "payout_address" || text === "trace_id" || text === "custom"
    ? text
    : "custom";
}

function parsePoolAllocationStrategy(value: unknown): SeedPoolConfig["allocation_strategy"] {
  const text = normalizeText(value);
  return text === "manual" ||
    text === "first_enabled" ||
    text === "round_robin" ||
    text === "random" ||
    text === "template"
    ? text
    : "manual";
}

function parseImportMode(value: unknown): SeedPoolConfig["auto_import_mode"] {
  return normalizeText(value) === "array_items" ? "array_items" : "whole";
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parsePoolSource(value: unknown): SeedPoolItemConfig["source"] {
  const record = parseRecord(value);
  const type = normalizeText(record.type);
  return {
    type: type === "run_output" || type === "fetch_scenario" ? type : "manual",
    run_id: normalizeText(record.run_id) || undefined,
    scenario_id: normalizeText(record.scenario_id) || undefined,
    output_key: normalizeText(record.output_key) || undefined
  };
}

function slugifyConfigId(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeConfiguredOtpSecret(value: unknown): string {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  return normalizeTotpSecret(text);
}

function resolveSeedAccountOtpSecret(value: unknown, legacyOtpSecrets: Record<string, string>): string {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const migrated = legacyOtpSecrets[text];
  return normalizeConfiguredOtpSecret(migrated || text);
}
