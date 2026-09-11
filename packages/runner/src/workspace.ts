import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  AUTH_STATE_FILE_NAME,
  METADATA_FILE_NAME,
  OTP_2FA_INPUT_TYPE,
  SCENARIO_FILE_NAME,
  ScenarioMetadataSchema,
  type ScenarioMetadata
} from "@ts-playwright/shared";
import { buildPlaywrightConfigModule, buildRuntimeModule } from "./runtime-template";
import { analyzeCodegenSource, prepareScenarioSource, type CodegenDiagnostic } from "./process-source";

export interface PreparedWorkspace {
  workspace_dir: string;
  artifacts_dir: string;
  metadata: ScenarioMetadata;
  diagnostics: CodegenDiagnostic[];
  cleanup: () => void;
}

export function prepareWorkspaceFromPackage(options: {
  scenario_zip: string;
  artifacts_dir: string;
  base_url: string;
  inputs?: Record<string, string>;
  otp_secrets?: Record<string, string>;
  otp_autoreplace?: boolean;
}): PreparedWorkspace {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-run-"));
  const cleanup = () => rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(options.artifacts_dir, { recursive: true });

  const zip = new AdmZip(options.scenario_zip);
  zip.extractAllTo(workspaceDir, true);
  return finalizeWorkspace({
    workspace_dir: workspaceDir,
    artifacts_dir: options.artifacts_dir,
    base_url: options.base_url,
    otp_autoreplace: options.otp_autoreplace,
    cleanup
  });
}

export function prepareWorkspaceFromSource(options: {
  source_path: string;
  metadata: ScenarioMetadata;
  artifacts_dir: string;
  base_url: string;
  auth_state_path?: string | null;
  otp_autoreplace?: boolean;
}): PreparedWorkspace {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-replay-"));
  const cleanup = () => rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(options.artifacts_dir, { recursive: true });

  writeFileSync(path.join(workspaceDir, METADATA_FILE_NAME), JSON.stringify(options.metadata, null, 2), "utf8");
  writeFileSync(path.join(workspaceDir, SCENARIO_FILE_NAME), readFileSync(options.source_path, "utf8"), "utf8");
  if (options.auth_state_path && existsSync(options.auth_state_path)) {
    copyFileSync(options.auth_state_path, path.join(workspaceDir, AUTH_STATE_FILE_NAME));
  }

  return finalizeWorkspace({
    workspace_dir: workspaceDir,
    artifacts_dir: options.artifacts_dir,
    base_url: options.base_url,
    otp_autoreplace: options.otp_autoreplace,
    cleanup
  });
}

function finalizeWorkspace(options: {
  workspace_dir: string;
  artifacts_dir: string;
  base_url: string;
  otp_autoreplace?: boolean;
  cleanup: () => void;
}): PreparedWorkspace {
  const metadataPath = path.join(options.workspace_dir, METADATA_FILE_NAME);
  const scenarioPath = path.join(options.workspace_dir, SCENARIO_FILE_NAME);
  if (!existsSync(metadataPath)) {
    throw new Error("metadata.json not found in package");
  }
  if (!existsSync(scenarioPath)) {
    throw new Error("scenario.spec.ts not found in package");
  }

  const metadata = ScenarioMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
  if (metadata.auth_state_ref) {
    const authSource = path.join(options.workspace_dir, metadata.auth_state_ref);
    const authTarget = path.join(options.workspace_dir, AUTH_STATE_FILE_NAME);
    if (existsSync(authSource) && authSource !== authTarget) {
      renameSync(authSource, authTarget);
    }
  }
  const source = readFileSync(scenarioPath, "utf8");
  const diagnostics = analyzeCodegenSource(source);
  const preparedSource = prepareScenarioSource(source, {
    base_url: options.base_url,
    otp_autoreplace: options.otp_autoreplace,
    async_input_names: metadata.inputs.filter((input) => input.type === OTP_2FA_INPUT_TYPE).map((input) => input.name)
  });
  writeFileSync(scenarioPath, preparedSource, "utf8");
  writeFileSync(path.join(options.workspace_dir, "pw-runtime.ts"), buildRuntimeModule(), "utf8");
  writeFileSync(path.join(options.workspace_dir, "playwright.config.ts"), buildPlaywrightConfigModule(), "utf8");
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return {
    workspace_dir: options.workspace_dir,
    artifacts_dir: options.artifacts_dir,
    metadata,
    diagnostics,
    cleanup: options.cleanup
  };
}
