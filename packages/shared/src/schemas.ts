import { z } from "zod";
import {
  DEFAULT_BROWSER,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT,
  OTP_2FA_INPUT_TYPE,
  STRING_INPUT_TYPE
} from "./constants";

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
  auth_state_ref: z.string().nullable().optional()
});

export const ProjectSchema = z.object({
  id: z.string().min(1),
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

export const OtpAccountSchema = z.object({
  login: z.string().min(1),
  secret: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
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

export const RunSchema = z.object({
  id: z.string().min(1),
  scenario_id: z.string().min(1),
  triggered_by: z.string().min(1),
  triggered_at: z.string().min(1),
  status: RunStatusSchema,
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  artifacts_path: z.string().nullable().optional(),
  stdout_path: z.string().nullable().optional(),
  stderr_path: z.string().nullable().optional(),
  summary_json: z.string().nullable().optional(),
  inputs: z.record(z.string()).default({})
});

export const AppStateSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  environments: z.array(EnvironmentSchema).default([]),
  otp_accounts: z.array(OtpAccountSchema).default([]),
  scenarios: z.array(ScenarioSchema).default([]),
  runs: z.array(RunSchema).default([])
});

export const RunCreateBodySchema = z.object({
  env_id: z.string().optional(),
  inputs: z.record(z.string()).default({})
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

export const OtpAccountUpsertBodySchema = z.object({
  login: z.string().min(1),
  secret: z.string().min(1)
});

export type InputSpec = z.infer<typeof InputSpecSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type ScenarioMetadata = z.infer<typeof ScenarioMetadataSchema>;
export type ProjectRecord = z.infer<typeof ProjectSchema>;
export type EnvironmentRecord = z.infer<typeof EnvironmentSchema>;
export type OtpAccountRecord = z.infer<typeof OtpAccountSchema>;
export type ScenarioRecord = z.infer<typeof ScenarioSchema>;
export type RunRecord = z.infer<typeof RunSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunCreateBody = z.infer<typeof RunCreateBodySchema>;
