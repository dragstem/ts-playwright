import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENARIO_FILE_NAME } from "@ts-playwright/shared";

const require = createRequire(import.meta.url);
const AdmZip = require("../apps/server/node_modules/adm-zip");

const runnerMocks = vi.hoisted(() => ({
  runScenarioInDocker: vi.fn()
}));

vi.mock("@ts-playwright/runner", () => ({
  detectForeignDomains: () => [],
  runScenarioInDocker: runnerMocks.runScenarioInDocker
}));

describe("server run retry", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-run-retry-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;
    runnerMocks.runScenarioInDocker.mockReset();
    runnerMocks.runScenarioInDocker.mockImplementation(async ({ artifacts_dir }: { artifacts_dir: string }) => ({
      status: "passed",
      artifacts_path: artifacts_dir,
      stdout_path: path.join(artifacts_dir, "stdout.log"),
      stderr_path: path.join(artifacts_dir, "stderr.log"),
      summary_json: JSON.stringify({ status: "passed" })
    }));
    vi.resetModules();
  });

  afterEach(() => {
    if (previousStorageDir === undefined) {
      delete process.env.APP_STORAGE_DIR;
    } else {
      process.env.APP_STORAGE_DIR = previousStorageDir;
    }
    vi.resetModules();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("queues a retry with the same env, stage, inputs, and otp login", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "retry-scenario",
      folderPath: "suite_retry",
      scenarioName: "Retry Scenario",
      inputs: [
        { name: "user_name", type: "string", description: "Login", otp_login: "" },
        { name: "otp_code", type: "2fa_otp", description: "OTP", otp_login: "" }
      ]
    });

    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          projects: [
            {
              id: "proj_demo",
              name: "Demo Project",
              description: "Sample project"
            }
          ],
          environments: [
            {
              id: "staging",
              project_id: "proj_demo",
              name: "staging",
              base_url: "https://staging.example.com",
              is_default: true
            },
            {
              id: "qa",
              project_id: "proj_demo",
              name: "qa",
              base_url: "https://qa.example.com",
              is_default: false
            }
          ],
          otp_accounts: [
            {
              login: "alice",
              secret: "JBSWY3DPEHPK3PXP",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z"
            }
          ],
          accounts: [
            {
              login: "alice",
              password: "secret-pass",
              "2fa_otp": "alice",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z"
            }
          ],
          merchants: [
            {
              name: "acme",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z"
            }
          ],
          scenarios: [scenario.record],
          runs: [
            {
              id: "run-existing",
              scenario_id: scenario.record.id,
              env_id: "qa",
              account_login: "alice",
              merchant_name: "acme",
              server_username: "alice",
              server_password: "secret-pass",
              server_2faotp: "JBSWY3DPEHPK3PXP",
              server_merchant: "acme",
              triggered_by: "api",
              triggered_at: "2026-01-01T10:00:00.000Z",
              batch_id: null,
              execution_stage: 3,
              default_timeout_ms: 45_000,
              status: "failed",
              started_at: "2026-01-01T10:00:05.000Z",
              finished_at: "2026-01-01T10:01:00.000Z",
              artifacts_path: null,
              stdout_path: null,
              stderr_path: null,
              summary_json: null,
              inputs: {
                user_name: "{server_username}",
                otp_code: "{server_2faotp}"
              },
              log_entries: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs/run-existing/retry"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          scenario_id: scenario.record.id,
          env_id: "qa",
          account_login: "alice",
          merchant_name: "acme",
          server_username: "alice",
          server_password: "secret-pass",
          server_2faotp: "JBSWY3DPEHPK3PXP",
          server_merchant: "acme",
          execution_stage: 3,
          default_timeout_ms: 45_000,
          status: "queued",
          inputs: {
            user_name: "{server_username}",
            otp_code: "{server_2faotp}"
          }
        })
      );

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });

      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          base_url: "https://qa.example.com",
          inputs: {
            user_name: "alice",
            server_username: "alice",
            server_password: "secret-pass",
            server_merchant: "acme"
          },
          otp_secrets: {
            otp_code: "JBSWY3DPEHPK3PXP",
            server_2faotp: "JBSWY3DPEHPK3PXP"
          },
          default_timeout_ms: 45_000
        })
      );

      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        runs: Array<{
          id: string;
          env_id: string | null;
          account_login: string | null;
          merchant_name: string | null;
          server_username: string | null;
          server_password: string | null;
          server_2faotp: string | null;
          server_merchant: string | null;
          execution_stage: number;
          default_timeout_ms?: number | null;
          inputs: Record<string, string>;
        }>;
      };
      expect(state.runs).toHaveLength(2);
      expect(state.runs[1]).toEqual(
        expect.objectContaining({
          env_id: "qa",
          account_login: "alice",
          merchant_name: "acme",
          server_username: "alice",
          server_password: "secret-pass",
          server_2faotp: "JBSWY3DPEHPK3PXP",
          server_merchant: "acme",
          execution_stage: 3,
          default_timeout_ms: 45_000,
          inputs: {
            user_name: "{server_username}",
            otp_code: "{server_2faotp}"
          }
        })
      );
    } finally {
      await app.close();
    }
  });

  it("queues a retry with edited input values", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "retry-edited-inputs",
      folderPath: "suite_retry",
      scenarioName: "Retry Edited Inputs",
      inputs: [
        { name: "user_name", type: "string", description: "Login", otp_login: "" },
        { name: "trace_id", type: "string", description: "Trace", otp_login: "" }
      ]
    });

    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          projects: [{ id: "proj_demo", name: "Demo Project", description: "Sample project" }],
          environments: [
            {
              id: "staging",
              project_id: "proj_demo",
              name: "staging",
              base_url: "https://staging.example.com",
              is_default: true
            }
          ],
          accounts: [],
          merchants: [],
          scenarios: [scenario.record],
          runs: [
            {
              id: "run-editable",
              scenario_id: scenario.record.id,
              env_id: "staging",
              account_login: null,
              merchant_name: null,
              server_username: null,
              server_password: null,
              server_2faotp: null,
              server_merchant: null,
              triggered_by: "api",
              triggered_at: "2026-01-01T10:00:00.000Z",
              batch_id: null,
              execution_stage: 1,
              default_timeout_ms: null,
              status: "failed",
              started_at: "2026-01-01T10:00:05.000Z",
              finished_at: "2026-01-01T10:01:00.000Z",
              artifacts_path: null,
              stdout_path: null,
              stderr_path: null,
              summary_json: null,
              inputs: {
                user_name: "old-user",
                trace_id: "old-trace"
              },
              log_entries: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs/run-editable/retry",
        payload: {
          default_timeout_ms: 30_000,
          server_username: "new-server-user",
          server_password: "new-server-pass",
          server_2faotp: "654321",
          server_merchant: "new-merchant",
          inputs: {
            user_name: "new-user",
            trace_id: "new-trace"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          inputs: {
            user_name: "new-user",
            trace_id: "new-trace"
          },
          default_timeout_ms: 30_000,
          server_username: "new-server-user",
          server_password: "new-server-pass",
          server_2faotp: "654321",
          server_merchant: "new-merchant"
        })
      );

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });

      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: {
            user_name: "new-user",
            trace_id: "new-trace",
            server_username: "new-server-user",
            server_password: "new-server-pass",
            server_2faotp: "654321",
            server_merchant: "new-merchant"
          },
          default_timeout_ms: 30_000
        })
      );
    } finally {
      await app.close();
    }
  });

  it("retries with stored manual server values even without saved presets", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "retry-manual-server",
      folderPath: "suite_retry",
      scenarioName: "Retry Manual Server",
      inputs: [
        { name: "user_name", type: "string", description: "Login", otp_login: "" },
        { name: "otp_code", type: "2fa_otp", description: "OTP", otp_login: "" }
      ]
    });

    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          projects: [
            {
              id: "proj_demo",
              name: "Demo Project",
              description: "Sample project"
            }
          ],
          environments: [
            {
              id: "staging",
              project_id: "proj_demo",
              name: "staging",
              base_url: "https://staging.example.com",
              is_default: true
            }
          ],
          accounts: [],
          merchants: [],
          scenarios: [scenario.record],
          runs: [
            {
              id: "run-manual",
              scenario_id: scenario.record.id,
              env_id: "staging",
              account_login: null,
              merchant_name: null,
              server_username: "manual-user",
              server_password: "manual-pass",
              server_2faotp: "123456",
              server_merchant: "manual-merchant",
              triggered_by: "api",
              triggered_at: "2026-01-01T10:00:00.000Z",
              batch_id: null,
              execution_stage: 2,
              default_timeout_ms: 9_000,
              status: "failed",
              started_at: "2026-01-01T10:00:05.000Z",
              finished_at: "2026-01-01T10:01:00.000Z",
              artifacts_path: null,
              stdout_path: null,
              stderr_path: null,
              summary_json: null,
              inputs: {
                user_name: "{server_username}",
                otp_code: "{server_2faotp}"
              },
              log_entries: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs/run-manual/retry"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          env_id: "staging",
          account_login: null,
          merchant_name: null,
          server_username: "manual-user",
          server_password: "manual-pass",
          server_2faotp: "123456",
          server_merchant: "manual-merchant",
          execution_stage: 2,
          default_timeout_ms: 9_000,
          status: "queued"
        })
      );

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });

      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          base_url: "https://staging.example.com",
          inputs: {
            user_name: "manual-user",
            otp_code: "123456",
            server_username: "manual-user",
            server_password: "manual-pass",
            server_2faotp: "123456",
            server_merchant: "manual-merchant"
          },
          default_timeout_ms: 9_000,
          otp_secrets: {}
        })
      );
    } finally {
      await app.close();
    }
  });

  // The retry run page was a server-rendered HTML view (html.ts), removed in Phase 3 / 3.15.
  // Retry behaviour itself is covered by the API tests above; the SPA's RunLive screen renders it now.
});

function createScenarioPackage(options: {
  storageDir: string;
  projectId: string;
  scenarioDirName: string;
  folderPath: string;
  scenarioName: string;
  inputs: Array<{ name: string; type: string; description: string; otp_login: string }>;
}): {
  record: {
    id: string;
    project_id: string;
    env_id: string;
    name: string;
    slug: string;
    folder_path: string;
    created_by: string;
    created_at: string;
    package_path: string;
    status: string;
    inputs: Array<{ name: string; type: string; description: string; otp_login: string }>;
  };
} {
  const scenarioId = `${options.scenarioDirName}-id`;
  const projectRoot = path.join(options.storageDir, "projects", options.projectId);
  const scenarioDir = path.join(projectRoot, options.folderPath, options.scenarioDirName);
  const packagePath = path.join(scenarioDir, "package.zip");
  mkdirSync(scenarioDir, { recursive: true });

  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        scenario_type: "playwright-test-ts",
        project_id: options.projectId,
        env_id: "staging",
        folder_path: options.folderPath,
        scenario_name: options.scenarioName,
        scenario_slug: slugify(options.scenarioName),
        recorded_at: "2026-01-01T00:00:00.000Z",
        recorded_by: "tester",
        recorded_base_url: "https://example.com",
        run_base_url: null,
        outputs: [],
        inputs: options.inputs,
        browser: "chromium",
        headless: true,
        viewport: { width: 1280, height: 720 },
        locale: "ru-RU",
        timezone: "Europe/Riga",
        requires_auth: false,
        auth_state_ref: null
      })
    )
  );
  zip.addFile(
    SCENARIO_FILE_NAME,
    Buffer.from('import { test } from "@playwright/test";\n\ntest("scenario", async () => {\n});\n')
  );
  zip.writeZip(packagePath);

  return {
    record: {
      id: scenarioId,
      project_id: options.projectId,
      env_id: "staging",
      name: options.scenarioName,
      slug: slugify(options.scenarioName),
      folder_path: options.folderPath,
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      package_path: packagePath,
      status: "active",
      inputs: options.inputs
    }
  };
}

function slugify(value: string): string {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "scenario";
}
