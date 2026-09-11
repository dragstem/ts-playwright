import { ScenarioMetadataSchema, type InputSpec, type OutputSpec, type ScenarioMetadata } from "./schemas";
import {
  DEFAULT_BROWSER,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT
} from "./constants";

export function buildScenarioMetadata(input: {
  project_id: string;
  env_id: string;
  folder_path: string;
  scenario_name: string;
  scenario_slug: string;
  recorded_by: string;
  recorded_base_url: string;
  run_base_url?: string | null;
  outputs?: OutputSpec[];
  inputs?: InputSpec[];
  requires_auth?: boolean;
  auth_state_ref?: string | null;
}): ScenarioMetadata {
  return ScenarioMetadataSchema.parse({
    schema_version: 2,
    scenario_type: "playwright-test-ts",
    project_id: input.project_id,
    env_id: input.env_id,
    folder_path: input.folder_path,
    scenario_name: input.scenario_name,
    scenario_slug: input.scenario_slug,
    recorded_at: new Date().toISOString(),
    recorded_by: input.recorded_by,
    recorded_base_url: input.recorded_base_url,
    run_base_url: input.run_base_url ?? null,
    outputs: input.outputs ?? [],
    inputs: input.inputs ?? [],
    browser: DEFAULT_BROWSER,
    headless: true,
    viewport: DEFAULT_VIEWPORT,
    locale: DEFAULT_LOCALE,
    timezone: DEFAULT_TIMEZONE,
    requires_auth: Boolean(input.requires_auth),
    auth_state_ref: input.auth_state_ref ?? null
  });
}
