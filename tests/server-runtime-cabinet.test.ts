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

describe("server runtime cabinet", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-runtime-cabinet-"));
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

  // The cabinet HTML pages (/cabinet, /cabinet/login) were removed in Phase 3 / 3.15 along with
  // html.ts and the fake cabinet_user. The runtime data they exposed (pools/items/merchants) is now
  // managed through /api/* + the SPA; the API behaviour stays covered by the tests below.

  it("creates pools and pool items through the server api", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const poolResponse = await app.inject({
        method: "POST",
        url: "/api/pools",
        payload: {
          id: "usdt-payouts",
          name: "USDT payouts",
          kind: "payout_address",
          allocation_strategy: "first_enabled"
        }
      });
      expect(poolResponse.statusCode).toBe(200);

      const itemResponse = await app.inject({
        method: "POST",
        url: "/api/pools/usdt-payouts/items",
        payload: {
          id: "addr-1",
          value: "TExampleAddress",
          currency: "USDT",
          network: "TRC20"
        }
      });
      expect(itemResponse.statusCode).toBe(200);
      expect(itemResponse.json()).toMatchObject({
        id: "addr-1",
        pool_id: "usdt-payouts",
        value: "TExampleAddress",
        currency: "USDT",
        network: "TRC20",
        source: { type: "manual" }
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/pools/usdt-payouts/items"
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([expect.objectContaining({ id: "addr-1" })]);
    } finally {
      await app.close();
    }
  });

  it("adds a run output to a pool with source provenance", async () => {
    const artifactsDir = path.join(storageDir, "artifacts", "run-output");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "outputs.json"), JSON.stringify({ deposit_address: "TDepositAddress" }), "utf8");
    writeBaseState({
      runs: [
        {
          id: "run-output",
          scenario_id: "scenario-output",
          env_id: "staging",
          account_login: null,
          merchant_name: null,
          server_username: null,
          server_password: null,
          server_2faotp: null,
          server_merchant: null,
          triggered_by: "api",
          triggered_at: "2026-01-01T00:00:00.000Z",
          retry_of_run_id: null,
          batch_id: null,
          execution_stage: 1,
          default_timeout_ms: null,
          status: "passed",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:02.000Z",
          artifacts_path: artifactsDir,
          stdout_path: null,
          stderr_path: null,
          summary_json: null,
          inputs: {},
          pool_selections: {},
          runtime_snapshot: {},
          log_entries: []
        }
      ],
      scenarios: [
        {
          id: "scenario-output",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Output Scenario",
          slug: "output_scenario",
          folder_path: "",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: path.join(storageDir, "missing.zip"),
          status: "active",
          inputs: []
        }
      ],
      pools: [
        {
          id: "deposits",
          name: "Deposits",
          kind: "deposit_address",
          project_id: null,
          env_ids: [],
          dedupe: true,
          allocation_strategy: "manual",
          template: "",
          fetch_scenario_id: null,
          fetch_input_name: "addresses_json",
          fetch_output_key: "address_info",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs/run-output/outputs/deposit_address/add-to-pool",
        payload: {
          pool_id: "deposits"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        pool_id: "deposits",
        imported_count: 1
      });

      const state = JSON.parse(readFileSync(path.join(storageDir, "app-state.json"), "utf8"));
      expect(state.pool_items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pool_id: "deposits",
            value: "TDepositAddress",
            source: expect.objectContaining({
              type: "run_output",
              run_id: "run-output",
              scenario_id: "scenario-output",
              output_key: "deposit_address"
            })
          })
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("bulk imports outputs from completed runs into a pool", async () => {
    const artifactsDir = path.join(storageDir, "artifacts", "run-bulk");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "outputs.json"), JSON.stringify({ addresses: ["TOne", "TTwo"] }), "utf8");
    writeBaseState({
      pools: [
        {
          id: "bulk-pool",
          name: "Bulk pool",
          kind: "deposit_address",
          project_id: null,
          env_ids: [],
          dedupe: true,
          allocation_strategy: "manual",
          template: "",
          fetch_scenario_id: null,
          fetch_input_name: "addresses_json",
          fetch_output_key: "address_info",
          auto_import_enabled: false,
          auto_import_scenario_id: null,
          auto_import_output_key: "",
          auto_import_mode: "whole",
          auto_import_json_path: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-bulk",
          scenario_id: "scenario-bulk",
          env_id: "staging",
          account_login: null,
          merchant_name: null,
          server_username: null,
          server_password: null,
          server_2faotp: null,
          server_merchant: null,
          triggered_by: "api",
          triggered_at: "2026-01-01T00:00:00.000Z",
          retry_of_run_id: null,
          batch_id: null,
          execution_stage: 1,
          default_timeout_ms: null,
          status: "passed",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:02.000Z",
          artifacts_path: artifactsDir,
          stdout_path: null,
          stderr_path: null,
          summary_json: null,
          inputs: {},
          pool_selections: {},
          runtime_snapshot: {},
          log_entries: []
        }
      ]
    });
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/pools/bulk-pool/import-run-outputs",
        payload: {
          output_key: "addresses",
          mode: "array_items"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ pool_id: "bulk-pool", imported_count: 2 });

      const state = JSON.parse(readFileSync(path.join(storageDir, "app-state.json"), "utf8"));
      expect(state.pool_items.map((item: { value: string }) => item.value).sort()).toEqual(["TOne", "TTwo"]);
    } finally {
      await app.close();
    }
  });

  it("queues retry with the same runtime snapshot and trace id", async () => {
    const scenario = createScenarioPackage({
      storageDir,
      scenarioId: "scenario-trace",
      scenarioName: "Trace Scenario",
      inputs: [{ name: "trace_id", type: "string", description: "", otp_login: "" }]
    });
    writeBaseState({
      scenarios: [scenario],
      pools: [
        {
          id: "trace-pool",
          name: "Trace pool",
          kind: "trace_id",
          project_id: null,
          env_ids: [],
          dedupe: true,
          allocation_strategy: "template",
          template: "{date}_{testName}_{seq}",
          fetch_scenario_id: null,
          fetch_input_name: "addresses_json",
          fetch_output_key: "address_info",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      runs: [
        {
          id: "run-failed",
          scenario_id: "scenario-trace",
          env_id: "staging",
          account_login: null,
          merchant_name: null,
          server_username: null,
          server_password: null,
          server_2faotp: null,
          server_merchant: null,
          triggered_by: "api",
          triggered_at: "2026-01-01T00:00:00.000Z",
          retry_of_run_id: null,
          batch_id: null,
          execution_stage: 1,
          default_timeout_ms: null,
          status: "failed",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:02.000Z",
          artifacts_path: null,
          stdout_path: null,
          stderr_path: null,
          summary_json: null,
          inputs: { trace_id: "same-trace" },
          pool_selections: { trace_id: { pool_id: "trace-pool", mode: "auto" } },
          runtime_snapshot: {
            pools: {
              trace_id: {
                pool_id: "trace-pool",
                value: "same-trace"
              }
            }
          },
          log_entries: []
        }
      ]
    });
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs/run-failed/retry"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        retry_of_run_id: "run-failed",
        inputs: { trace_id: "same-trace" },
        runtime_snapshot: {
          pools: {
            trace_id: {
              pool_id: "trace-pool",
              value: "same-trace"
            }
          }
        }
      });
    } finally {
      await app.close();
    }
  });

  it("uses a merchant linked admin as the otp source", async () => {
    const scenario = createScenarioPackage({
      storageDir,
      scenarioId: "scenario-merchant-admin",
      scenarioName: "Merchant Admin Scenario",
      inputs: [
        { name: "login", type: "string", description: "", otp_login: "" },
        { name: "otp", type: "2fa_otp", description: "", otp_login: "" }
      ]
    });
    writeBaseState({
      scenarios: [scenario],
      accounts: [
        {
          login: "admin",
          password: "admin-pass",
          "2fa_otp": "JBSWY3DPEHPK3PXP",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      merchants: [
        {
          name: "merchant-a",
          admin_login: "admin",
          env_ids: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/scenarios/scenario-merchant-admin/run",
        payload: {
          merchant_name: "merchant-a",
          inputs: {
            login: "{server_username}",
            otp: "{server_2faotp}"
          }
        }
      });
      expect(response.statusCode).toBe(200);

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });
      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: expect.objectContaining({
            login: "admin",
            server_username: "admin",
            server_password: "admin-pass",
            server_merchant: "merchant-a"
          }),
          otp_secrets: expect.objectContaining({
            otp: "JBSWY3DPEHPK3PXP",
            server_2faotp: "JBSWY3DPEHPK3PXP"
          })
        })
      );
    } finally {
      await app.close();
    }
  });
});

function writeBaseState(overrides: Record<string, unknown>): void {
  const storageDir = String(process.env.APP_STORAGE_DIR);
  const state = {
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
    pools: [],
    pool_items: [],
    scenarios: [],
    runs: [],
    ...overrides
  };
  writeFileSync(path.join(storageDir, "app-state.json"), JSON.stringify(state, null, 2), "utf8");
}

function createScenarioPackage(options: {
  storageDir: string;
  scenarioId: string;
  scenarioName: string;
  folderPath?: string;
  inputs: Array<{ name: string; type: string; description: string; otp_login: string }>;
}) {
  const projectRoot = path.join(options.storageDir, "projects", "proj_demo");
  const folderPath = options.folderPath ?? "";
  const scenarioDir = path.join(projectRoot, folderPath, options.scenarioId);
  const packagePath = path.join(scenarioDir, "package.zip");
  mkdirSync(scenarioDir, { recursive: true });

  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        scenario_type: "playwright-test-ts",
        project_id: "proj_demo",
        env_id: "staging",
        folder_path: folderPath,
        scenario_name: options.scenarioName,
        scenario_slug: options.scenarioId,
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
  zip.addFile(SCENARIO_FILE_NAME, Buffer.from('import { test } from "@playwright/test";\n\ntest("scenario", async () => {});\n'));
  zip.writeZip(packagePath);

  return {
    id: options.scenarioId,
    project_id: "proj_demo",
    env_id: "staging",
    name: options.scenarioName,
    slug: options.scenarioId,
    folder_path: folderPath,
    created_by: "tester",
    created_at: "2026-01-01T00:00:00.000Z",
    package_path: packagePath,
    status: "active",
    inputs: options.inputs
  };
}
