import { z } from "zod";
import {
  DEFAULT_BROWSER,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT,
  OTP_2FA_INPUT_TYPE,
  STRING_INPUT_TYPE
} from "./constants";

const PositiveIntMsSchema = z.coerce.number().int().positive();
const PositiveIntSchema = z.coerce.number().int().positive();

export const InputSpecSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum([STRING_INPUT_TYPE, OTP_2FA_INPUT_TYPE]).default(STRING_INPUT_TYPE),
    description: z.string().default(""),
    otp_login: z.string().default("")
  })
  .transform((value) => ({
    ...value,
    otp_login: value.type === OTP_2FA_INPUT_TYPE ? value.otp_login : ""
  }));

export const OutputSpecSchema = z.object({
  key: z.string().min(1),
  selector: z.string().min(1),
  mode: z.string().default("text"),
  attr: z.string().optional(),
  frame: z.string().optional(),
  timeout_ms: z.number().int().positive().optional()
});

export const ScenarioMetadataSchema = z.object({
  schema_version: z.number().int().default(2),
  scenario_type: z.literal("playwright-test-ts").default("playwright-test-ts"),
  project_id: z.string().min(1),
  env_id: z.string().min(1),
  folder_path: z.string().default(""),
  scenario_name: z.string().min(1),
  scenario_slug: z.string().min(1),
  recorded_at: z.string().min(1),
  recorded_by: z.string().min(1),
  recorded_base_url: z.string().min(1),
  run_base_url: z.string().nullable().optional(),
  outputs: z.array(OutputSpecSchema).default([]),
  inputs: z.array(InputSpecSchema).default([]),
  browser: z.string().default(DEFAULT_BROWSER),
  headless: z.boolean().default(true),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
    .default(DEFAULT_VIEWPORT),
  locale: z.string().default(DEFAULT_LOCALE),
  timezone: z.string().default(DEFAULT_TIMEZONE),
  requires_auth: z.boolean().default(false),
  auth_state_ref: z.string().nullable().optional(),
  // Phase 2 / 2-R4 — stable ULID anchor written by the server on first upload so re-uploads of the
  // same scenario reconcile to the same id even if the folder/slug changes.
  scenario_ulid: z.string().nullable().optional()
});

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional()
});

// Phase 3 — create a project (project-creation wizard). id is optional; the server mints one.
export const ProjectUpsertBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional()
});

export const EnvironmentSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  name: z.string().min(1),
  base_url: z.string().min(1),
  is_default: z.boolean().default(false)
});

// Create an environment for a project. An explicit id is allowed so a recorded scenario's env_id
// can be matched; otherwise the server mints one.
export const EnvironmentUpsertBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  base_url: z.string().min(1),
  is_default: z.boolean().optional()
});

export const AccountSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
  "2fa_otp": z.string().default(""),
  // Phase 2 / 2-R9 — project scope. null = global default (usable by every project); a project_id
  // scopes the record to that project. Existing global records parse as null (backward compatible).
  project_id: z.string().nullable().default(null),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});

export const MerchantSchema = z.object({
  name: z.string().min(1),
  admin_login: z.string().nullable().default(null),
  env_ids: z.array(z.string()).default([]),
  project_id: z.string().nullable().default(null),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});

// Phase 2 / 2.M3 — per-project default server_* values (multiproject). Secrets (password,
// 2faotp) are sealed at rest; resolved at run time as a fallback after account/merchant.
export const ProjectServerVarsSchema = z.object({
  project_id: z.string().min(1),
  server_username: z.string().default(""),
  server_password: z.string().default(""),
  server_2faotp: z.string().default(""),
  server_merchant: z.string().default(""),
  extra: z.record(z.string()).default({}),
  created_at: z.string().default(""),
  updated_at: z.string().default("")
});

export const PoolKindSchema = z.enum(["deposit_address", "payout_address", "trace_id", "custom"]);

export const PoolAllocationStrategySchema = z.enum(["manual", "first_enabled", "round_robin", "random", "template"]);

export const PoolSourceSchema = z.object({
  type: z.enum(["manual", "run_output", "fetch_scenario"]).default("manual"),
  run_id: z.string().optional(),
  scenario_id: z.string().optional(),
  output_key: z.string().optional()
});

export const PoolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: PoolKindSchema.default("custom"),
  project_id: z.string().nullable().default(null),
  env_ids: z.array(z.string()).default([]),
  dedupe: z.boolean().default(true),
  allocation_strategy: PoolAllocationStrategySchema.default("manual"),
  template: z.string().default(""),
  fetch_scenario_id: z.string().nullable().default(null),
  fetch_input_name: z.string().default("addresses_json"),
  fetch_output_key: z.string().default("address_info"),
  auto_import_enabled: z.boolean().default(false),
  auto_import_scenario_id: z.string().nullable().default(null),
  auto_import_output_key: z.string().default(""),
  auto_import_mode: z.enum(["whole", "array_items"]).default("whole"),
  auto_import_json_path: z.string().default(""),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});

export const PoolItemSchema = z.object({
  id: z.string().min(1),
  pool_id: z.string().min(1),
  value: z.string().min(1),
  label: z.string().default(""),
  enabled: z.boolean().default(true),
  currency: z.string().default(""),
  network: z.string().default(""),
  metadata: z.record(z.unknown()).default({}),
  source: PoolSourceSchema.default({ type: "manual" }),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  last_fetched_at: z.string().nullable().default(null),
  last_fetch_status: z.string().nullable().default(null)
});

export const PoolSelectionSchema = z.object({
  pool_id: z.string().min(1),
  item_id: z.string().optional(),
  mode: z.enum(["auto", "manual"]).default("auto")
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  env_id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  folder_path: z.string().default(""),
  created_by: z.string().min(1),
  created_at: z.string().min(1),
  package_path: z.string().min(1),
  status: z.string().default("active"),
  inputs: z.array(InputSpecSchema).default([])
});

export const RunStatusSchema = z.enum(["queued", "running", "passed", "failed", "error"]);

// Phase 2/3 (2-R11) — fine-grained execution sub-phase for the live Timeline. The persisted
// `status` contract above is unchanged; `phase`/`outcome` are an additive overlay.
export const RunPhaseSchema = z.enum([
  "queued",
  "prepare",
  "pull_image",
  "create_container",
  "execute",
  "collecting",
  "done"
]);

export const RunOutcomeSchema = z.enum(["passed", "failed", "error", "timeout", "stopped", "interrupted"]);

export const RunPhaseTimingSchema = z.object({
  started_at: z.string(),
  duration_ms: z.number().nullable().default(null),
  status: z.enum(["active", "done", "skipped", "failed"]).default("active")
});

export const RunLogLevelSchema = z.enum(["info", "warning", "error"]);

export const RunLogEntrySchema = z.object({
  timestamp: z.string().min(1),
  level: RunLogLevelSchema.default("info"),
  message: z.string().min(1)
});

export const RunSchema = z.object({
  id: z.string().min(1),
  scenario_id: z.string().min(1),
  env_id: z.string().nullable().default(null),
  account_login: z.string().nullable().default(null),
  merchant_name: z.string().nullable().default(null),
  server_username: z.string().nullable().default(null),
  server_password: z.string().nullable().default(null),
  server_2faotp: z.string().nullable().default(null),
  server_merchant: z.string().nullable().default(null),
  triggered_by: z.string().min(1),
  triggered_at: z.string().min(1),
  retry_of_run_id: z.string().nullable().default(null),
  batch_id: z.string().nullable().optional(),
  execution_stage: z.number().int().positive().default(1),
  amount_times_to_run: z.number().int().positive().default(1),
  // When true, the run inserts nothing for any input variable (every {{INPUT:*}}/{server_*}/pool/auto
  // token resolves to an empty string at run time). Additive; old runs parse back as false.
  ignore_variables: z.boolean().default(false),
  // Individual input names to skip (insert nothing) — the per-variable form of ignore_variables.
  ignored_inputs: z.array(z.string()).default([]),
  run_iteration: z.number().int().positive().default(1),
  default_timeout_ms: PositiveIntMsSchema.nullable().optional(),
  status: RunStatusSchema,
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  artifacts_path: z.string().nullable().optional(),
  stdout_path: z.string().nullable().optional(),
  stderr_path: z.string().nullable().optional(),
  summary_json: z.string().nullable().optional(),
  inputs: z.record(z.string()).default({}),
  pool_selections: z.record(PoolSelectionSchema).default({}),
  runtime_snapshot: z.record(z.unknown()).default({}),
  log_entries: z.array(RunLogEntrySchema).default([]),
  phase: RunPhaseSchema.default("queued"),
  outcome: RunOutcomeSchema.nullable().optional(),
  phase_timings: z.record(RunPhaseTimingSchema).default({})
});

export const AppStateSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  environments: z.array(EnvironmentSchema).default([]),
  accounts: z.array(AccountSchema).default([]),
  merchants: z.array(MerchantSchema).default([]),
  project_server_vars: z.array(ProjectServerVarsSchema).default([]),
  pools: z.array(PoolSchema).default([]),
  pool_items: z.array(PoolItemSchema).default([]),
  scenarios: z.array(ScenarioSchema).default([]),
  runs: z.array(RunSchema).default([])
});

const ServerRunSelectionSchema = z.object({
  account_login: z.string().optional(),
  merchant_name: z.string().optional(),
  server_username: z.string().optional(),
  server_password: z.string().optional(),
  server_2faotp: z.string().optional(),
  server_merchant: z.string().optional()
});

export const RunCreateBodySchema = z.object({
  env_id: z.string().optional(),
  ...ServerRunSelectionSchema.shape,
  inputs: z.record(z.string()).default({}),
  pool_selections: z.record(PoolSelectionSchema).default({}),
  ensure_right_address_to_run: z.boolean().default(false),
  ignore_variables: z.boolean().default(false),
  ignored_inputs: z.array(z.string()).default([]),
  amount_times_to_run: PositiveIntSchema.default(1),
  parallel_batch_size: PositiveIntSchema.optional(),
  default_timeout_ms: PositiveIntMsSchema.optional()
});

export const FolderRunCreateBodySchema = z.object({
  folder_paths: z.array(z.string()).min(1),
  scenario_ids: z.array(z.string()).optional(),
  ...ServerRunSelectionSchema.shape,
  shared_inputs: z.record(z.string()).default({}),
  pool_selections: z.record(PoolSelectionSchema).default({}),
  ensure_right_address_to_run: z.boolean().default(false),
  ignore_variables: z.boolean().default(false),
  ignored_inputs: z.array(z.string()).default([]),
  scenario_inputs: z.record(z.record(z.string())).default({}),
  scenario_execution: z
    .record(
      z.object({
        stage: z.coerce.number().int().positive().default(1),
        amount_times_to_run: PositiveIntSchema.default(1),
        parallel_batch_size: PositiveIntSchema.optional(),
        default_timeout_ms: PositiveIntMsSchema.optional()
      })
    )
    .default({})
});

export const FolderCreateBodySchema = z.object({
  path: z.string()
});

export const FolderMoveBodySchema = z.object({
  from_path: z.string(),
  to_path: z.string()
});

export const ScenarioMoveBodySchema = z.object({
  path: z.string().default("")
});

export const AccountUpsertBodySchema = z.object({
  login: z.string().min(1),
  // Optional for write-only edits: an absent/empty password keeps the stored secret.
  // A password is still required when creating a new account (enforced in the handler).
  password: z.string().optional(),
  "2fa_otp": z.string().optional(),
  project_id: z.string().nullable().optional()
});

export const MerchantUpsertBodySchema = z.object({
  name: z.string().min(1),
  admin_login: z.string().nullable().optional(),
  env_ids: z.array(z.string()).optional(),
  project_id: z.string().nullable().optional()
});

export const AccountOtpCodeCreateBodySchema = z.object({
  login: z.string().min(1)
});

export const PoolUpsertBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: PoolKindSchema.default("custom"),
  project_id: z.string().nullable().optional(),
  env_ids: z.array(z.string()).optional(),
  dedupe: z.boolean().optional(),
  allocation_strategy: PoolAllocationStrategySchema.optional(),
  template: z.string().optional(),
  fetch_scenario_id: z.string().nullable().optional(),
  fetch_input_name: z.string().optional(),
  fetch_output_key: z.string().optional(),
  auto_import_enabled: z.boolean().optional(),
  auto_import_scenario_id: z.string().nullable().optional(),
  auto_import_output_key: z.string().optional(),
  auto_import_mode: z.enum(["whole", "array_items"]).optional(),
  auto_import_json_path: z.string().optional()
});

export const PoolItemUpsertBodySchema = z.object({
  id: z.string().optional(),
  value: z.string().min(1),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  currency: z.string().optional(),
  network: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  source: PoolSourceSchema.optional()
});

// Bulk add pool items — one value per line from the client. The server trims each value, drops blank
// and duplicate lines, and auto-generates id + label. Raw (untrimmed) strings are accepted; the server
// normalizes them.
export const PoolItemBulkBodySchema = z.object({
  values: z.array(z.string()).min(1)
});

export const RunOutputAddToPoolBodySchema = z.object({
  pool_id: z.string().min(1),
  mode: z.enum(["whole", "array_items"]).default("whole"),
  json_path: z.string().optional(),
  create_pool: PoolUpsertBodySchema.optional()
});

export const PoolImportRunOutputsBodySchema = z.object({
  scenario_id: z.string().optional(),
  output_key: z.string().min(1),
  status: z.enum(["passed", "failed", "error"]).optional(),
  mode: z.enum(["whole", "array_items"]).default("whole"),
  json_path: z.string().optional()
});

export type InputSpec = z.infer<typeof InputSpecSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type ScenarioMetadata = z.infer<typeof ScenarioMetadataSchema>;
export type ProjectRecord = z.infer<typeof ProjectSchema>;
export type EnvironmentRecord = z.infer<typeof EnvironmentSchema>;
export type AccountRecord = z.infer<typeof AccountSchema>;
export type MerchantRecord = z.infer<typeof MerchantSchema>;
export type ProjectServerVarsRecord = z.infer<typeof ProjectServerVarsSchema>;
export type PoolRecord = z.infer<typeof PoolSchema>;
export type PoolItemRecord = z.infer<typeof PoolItemSchema>;
export type PoolSelection = z.infer<typeof PoolSelectionSchema>;
export type ScenarioRecord = z.infer<typeof ScenarioSchema>;
export type RunRecord = z.infer<typeof RunSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunPhase = z.infer<typeof RunPhaseSchema>;
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export type RunPhaseTiming = z.infer<typeof RunPhaseTimingSchema>;
export type RunLogLevel = z.infer<typeof RunLogLevelSchema>;
export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;
export type RunCreateBody = z.infer<typeof RunCreateBodySchema>;
export type FolderRunCreateBody = z.infer<typeof FolderRunCreateBodySchema>;
