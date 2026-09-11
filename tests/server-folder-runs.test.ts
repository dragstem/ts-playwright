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

describe("server folder runs API", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-folder-run-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;
    runnerMocks.runScenarioInDocker.mockReset();
    runnerMocks.runScenarioInDocker.mockImplementation(
      async ({ artifacts_dir, on_log }: { artifacts_dir: string; on_log?: (entry: { timestamp: string; level: string; message: string }) => void }) => {
        on_log?.({
          timestamp: "2026-01-01T00:00:01.000Z",
          level: "info",
          message: "Docker image is ready."
        });
        return {
          status: "passed",
          artifacts_path: artifacts_dir,
          stdout_path: path.join(artifacts_dir, "stdout.log"),
          stderr_path: path.join(artifacts_dir, "stderr.log"),
          summary_json: JSON.stringify({ status: "passed" })
        };
      }
    );
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

  it("queues one run per scenario across selected folders", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "login-scenario",
      folderPath: "suite_a",
      scenarioName: "Login Flow",
      inputs: [{ name: "user_name", type: "string", description: "", otp_login: "" }]
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "profile-scenario",
      folderPath: "suite_b/child",
      scenarioName: "Profile Flow",
      inputs: []
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
              base_url: "https://example.com",
              is_default: true
            }
          ],
          scenarios: [scenarioOne.record, scenarioTwo.record],
          runs: []
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
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_a", "suite_b"],
          scenario_inputs: {
            [scenarioOne.record.id]: {
              user_name: "alice"
            }
          },
          scenario_execution: {
            [scenarioOne.record.id]: {
              default_timeout_ms: 45_000
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.scenario_count).toBe(2);
      expect(payload.runs).toHaveLength(2);
      expect(payload.runs[0]?.scenario_id).toBe(scenarioOne.record.id);
      expect(payload.runs[0]?.inputs).toEqual({ user_name: "alice" });
      expect(payload.runs[0]?.execution_stage).toBe(1);
      expect(payload.runs[0]?.default_timeout_ms).toBe(45_000);
      expect(payload.runs[0]?.batch_id).toBeTruthy();
      expect(payload.runs[1]?.scenario_id).toBe(scenarioTwo.record.id);
      expect(payload.runs[1]?.default_timeout_ms).toBeNull();
      expect(payload.runs[1]?.batch_id).toBe(payload.runs[0]?.batch_id);

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(2);
      });
      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          default_timeout_ms: 45_000
        })
      );

      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        runs: Array<{
          scenario_id: string;
          status: string;
          default_timeout_ms?: number | null;
          log_entries: Array<{ message: string }>;
        }>;
      };
      expect(state.runs).toHaveLength(2);
      expect(state.runs.every((run) => run.status === "passed")).toBe(true);
      expect(state.runs.every((run) => run.log_entries.some((entry) => entry.message === "Docker image is ready."))).toBe(true);
      expect(state.runs.find((run) => run.scenario_id === scenarioOne.record.id)?.default_timeout_ms).toBe(45_000);
    } finally {
      await app.close();
    }
  });

  it("queues only selected scenarios from selected folders", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "selected-one",
      folderPath: "suite_selected",
      scenarioName: "Selected One",
      inputs: []
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "selected-two",
      folderPath: "suite_selected",
      scenarioName: "Selected Two",
      inputs: []
    });

    writeStateFile(stateFile, [scenarioOne.record, scenarioTwo.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_selected"],
          scenario_ids: [scenarioTwo.record.id]
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.scenario_count).toBe(1);
      expect(payload.scenario_ids).toEqual([scenarioTwo.record.id]);
      expect(payload.runs).toHaveLength(1);
      expect(payload.runs[0]?.scenario_id).toBe(scenarioTwo.record.id);

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });
    } finally {
      await app.close();
    }
  });

  it("runs a project-wide selection with a per-scenario run count (SPA batch wizard shape)", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioA = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "wide-a",
      folderPath: "folder_a",
      scenarioName: "Wide A",
      inputs: []
    });
    const scenarioB = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "wide-b",
      folderPath: "folder_b",
      scenarioName: "Wide B",
      inputs: []
    });
    writeStateFile(stateFile, [scenarioA.record, scenarioB.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();
    try {
      // folder_paths [""] = whole project; scenario_ids narrow it; scenario_execution sets the count.
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: [""],
          scenario_ids: [scenarioA.record.id, scenarioB.record.id],
          scenario_execution: {
            [scenarioA.record.id]: { amount_times_to_run: 2 },
            [scenarioB.record.id]: { amount_times_to_run: 2 }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.scenario_count).toBe(4); // 2 scenarios × 2 runs
      expect(payload.batch_id).toBeTruthy();
      expect(payload.runs.every((run: { batch_id: string }) => run.batch_id === payload.batch_id)).toBe(true);

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(4);
      });
    } finally {
      await app.close();
    }
  });

  it("resolves a pool_selections entry (keyed by input name) into the run's input", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "pooled",
      folderPath: "suite_pool",
      scenarioName: "Pooled",
      inputs: [{ name: "promo_code", type: "string", description: "", otp_login: "" }]
    });
    writeFileSync(
      stateFile,
      JSON.stringify({
        projects: [{ id: "proj_demo", name: "Demo Project", description: "" }],
        environments: [{ id: "staging", project_id: "proj_demo", name: "staging", base_url: "https://example.com", is_default: true }],
        pools: [
          {
            id: "pool-promo",
            name: "Promo codes",
            kind: "custom",
            project_id: null,
            env_ids: [],
            allocation_strategy: "first_enabled",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ],
        pool_items: [
          {
            id: "item-1",
            pool_id: "pool-promo",
            value: "PROMO-XYZ",
            enabled: true,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ],
        scenarios: [scenario.record],
        runs: []
      }),
      "utf8"
    );

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: [""],
          scenario_ids: [scenario.record.id],
          pool_selections: { promo_code: { pool_id: "pool-promo", mode: "auto" } }
        }
      });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.runs[0]?.inputs?.promo_code).toBe("PROMO-XYZ");
    } finally {
      await app.close();
    }
  });

  it("runs same-stage scenarios in parallel and waits before starting the next stage", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "stage-one-a",
      folderPath: "suite_parallel",
      scenarioName: "Stage One A",
      inputs: []
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "stage-one-b",
      folderPath: "suite_parallel",
      scenarioName: "Stage One B",
      inputs: []
    });
    const scenarioThree = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "stage-two",
      folderPath: "suite_sequential",
      scenarioName: "Stage Two",
      inputs: []
    });

    writeStateFile(stateFile, [scenarioOne.record, scenarioTwo.record, scenarioThree.record]);

    const started: string[] = [];
    const deferreds = new Map<string, ReturnType<typeof createDeferred>>();
    runnerMocks.runScenarioInDocker.mockReset();
    runnerMocks.runScenarioInDocker.mockImplementation(
      ({ scenario_zip, artifacts_dir }: { scenario_zip: string; artifacts_dir: string }) => {
        const key = path.basename(path.dirname(scenario_zip));
        started.push(key);
        const deferred = createDeferred();
        deferreds.set(key, deferred);
        return deferred.promise.then(() => ({
          status: "passed",
          artifacts_path: artifacts_dir,
          stdout_path: path.join(artifacts_dir, "stdout.log"),
          stderr_path: path.join(artifacts_dir, "stderr.log"),
          summary_json: JSON.stringify({ status: "passed" })
        }));
      }
    );

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_parallel", "suite_sequential"],
          scenario_execution: {
            [scenarioOne.record.id]: { stage: 1 },
            [scenarioTwo.record.id]: { stage: 1 },
            [scenarioThree.record.id]: { stage: 2 }
          }
        }
      });

      expect(response.statusCode).toBe(200);

      await vi.waitFor(() => {
        expect(started).toContain("stage-one-a");
        expect(started).toContain("stage-one-b");
      });
      expect(started).not.toContain("stage-two");

      deferreds.get("stage-one-a")?.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(started).not.toContain("stage-two");

      deferreds.get("stage-one-b")?.resolve();
      await vi.waitFor(() => {
        expect(started).toContain("stage-two");
      });

      deferreds.get("stage-two")?.resolve();
      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(3);
      });
    } finally {
      deferreds.forEach((deferred) => deferred.resolve());
      await app.close();
    }
  });

  it("reuses shared inputs for matching scenarios and keeps scenario-specific overrides", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "shared-one",
      folderPath: "suite_shared",
      scenarioName: "Shared One",
      inputs: [{ name: "user_name", type: "string", description: "", otp_login: "" }]
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "shared-two",
      folderPath: "suite_shared",
      scenarioName: "Shared Two",
      inputs: [{ name: "user_name", type: "string", description: "", otp_login: "" }]
    });

    writeStateFile(stateFile, [scenarioOne.record, scenarioTwo.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_shared"],
          shared_inputs: {
            user_name: "alice"
          },
          scenario_inputs: {
            [scenarioTwo.record.id]: {
              user_name: "bob"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.shared_inputs).toEqual({ user_name: "alice" });
      expect(payload.runs).toHaveLength(2);

      const runsByScenarioId = new Map(
        payload.runs.map((run: { scenario_id: string; inputs: Record<string, string> }) => [run.scenario_id, run])
      );
      expect(runsByScenarioId.get(scenarioOne.record.id)?.inputs).toEqual({ user_name: "alice" });
      expect(runsByScenarioId.get(scenarioTwo.record.id)?.inputs).toEqual({ user_name: "bob" });

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(2);
      });
    } finally {
      await app.close();
    }
  });

  it("expands shared templates into unique values for folder runs", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "template-one",
      folderPath: "suite_trace/alpha",
      scenarioName: "Template One",
      inputs: [{ name: "request_id", type: "string", description: "", otp_login: "" }]
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "template-two",
      folderPath: "suite_trace/beta",
      scenarioName: "Template Two",
      inputs: [{ name: "request_id", type: "string", description: "", otp_login: "" }]
    });

    writeStateFile(stateFile, [scenarioOne.record, scenarioTwo.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_trace"],
          shared_inputs: {
            request_id: "{input_name}_{folder_name}_{uniq_number}"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.runs).toHaveLength(2);

      const runsByScenarioId = new Map(
        payload.runs.map((run: { scenario_id: string; inputs: Record<string, string> }) => [run.scenario_id, run])
      );
      const requestOne = runsByScenarioId.get(scenarioOne.record.id)?.inputs.request_id;
      const requestTwo = runsByScenarioId.get(scenarioTwo.record.id)?.inputs.request_id;

      expect(requestOne).toMatch(/^request_id_alpha_\d{15}$/);
      expect(requestTwo).toMatch(/^request_id_beta_\d{15}$/);
      expect(requestOne).not.toBe(requestTwo);

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(2);
      });
    } finally {
      await app.close();
    }
  });

  it("passes selected server account and merchant placeholders into queued folder runs", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "server-placeholders",
      folderPath: "suite_server",
      scenarioName: "Server Placeholders",
      inputs: [
        { name: "login_value", type: "string", description: "", otp_login: "" },
        { name: "password_value", type: "string", description: "", otp_login: "" },
        { name: "otp_value", type: "2fa_otp", description: "", otp_login: "" },
        { name: "merchant_value", type: "string", description: "", otp_login: "" }
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
              base_url: "https://example.com",
              is_default: true
            }
          ],
          otp_accounts: [
            {
              login: "qa-admin",
              secret: "JBSWY3DPEHPK3PXP",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z"
            }
          ],
          accounts: [
            {
              login: "alice",
              password: "secret-pass",
              "2fa_otp": "qa-admin",
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
          runs: []
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
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_server"],
          account_login: "alice",
          merchant_name: "acme",
          scenario_inputs: {
            [scenario.record.id]: {
              login_value: "{server_username}",
              password_value: "{server_password}",
              otp_value: "{server_2faotp}",
              merchant_value: "{server_merchant}"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        account_login: "alice",
        merchant_name: "acme",
        server_username: "alice",
        server_password: "secret-pass",
        server_2faotp: "JBSWY3DPEHPK3PXP",
        server_merchant: "acme"
      });

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });

      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: {
            login_value: "alice",
            password_value: "secret-pass",
            merchant_value: "acme",
            server_username: "alice",
            server_password: "secret-pass",
            server_merchant: "acme"
          },
          otp_secrets: {
            otp_value: "JBSWY3DPEHPK3PXP",
            server_2faotp: "JBSWY3DPEHPK3PXP"
          }
        })
      );

      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        runs: Array<{
          account_login: string | null;
          merchant_name: string | null;
          server_username: string | null;
          server_password: string | null;
          server_2faotp: string | null;
          server_merchant: string | null;
          inputs: Record<string, string>;
        }>;
      };
      expect(state.runs[0]).toMatchObject({
        account_login: "alice",
        merchant_name: "acme",
        server_username: "alice",
        server_password: "secret-pass",
        server_2faotp: "JBSWY3DPEHPK3PXP",
        server_merchant: "acme",
        inputs: {
          login_value: "{server_username}",
          password_value: "{server_password}",
          otp_value: "{server_2faotp}",
          merchant_value: "{server_merchant}"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("serves the recorded scenario source over /api/scenarios/:id/code", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "code-view",
      folderPath: "suite_code",
      scenarioName: "Code View",
      inputs: []
    });
    writeStateFile(stateFile, [scenario.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();
    try {
      const res = await app.inject({ method: "GET", url: `/api/scenarios/${scenario.record.id}/code` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { filename: string; code: string };
      expect(body.filename).toBe("scenario.spec.ts");
      expect(body.code).toContain('import { test } from "@playwright/test"');

      const missing = await app.inject({ method: "GET", url: "/api/scenarios/nope/code" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("exposes batch aggregates over /api/batches[/:id] (2-R11)", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenarioOne = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "batch-one",
      folderPath: "suite_batch",
      scenarioName: "Batch One",
      inputs: []
    });
    const scenarioTwo = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "batch-two",
      folderPath: "suite_batch",
      scenarioName: "Batch Two",
      inputs: []
    });

    writeStateFile(stateFile, [scenarioOne.record, scenarioTwo.record]);

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/folder-runs",
        payload: { folder_paths: ["suite_batch"] }
      });
      expect(response.statusCode).toBe(200);
      const batchId = response.json().batch_id as string;
      expect(batchId).toBeTruthy();

      // Wait for both queued runs to finish (the mocked runner resolves them as passed).
      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(async () => {
        const detail = await app.inject({ method: "GET", url: `/api/batches/${batchId}` });
        expect(detail.json().status).toBe("passed");
      });

      const list = await app.inject({ method: "GET", url: "/api/batches" });
      expect(list.statusCode).toBe(200);
      const batches = list.json().batches as Array<{ batch_id: string; total: number; project_id: string }>;
      const summary = batches.find((batch) => batch.batch_id === batchId);
      expect(summary).toMatchObject({ total: 2, project_id: "proj_demo" });

      const detail = await app.inject({ method: "GET", url: `/api/batches/${batchId}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        batch_id: batchId,
        total: 2,
        done: 2,
        in_progress: false,
        status: "passed",
        counts: { passed: 2 }
      });
      expect((detail.json().runs as unknown[]).length).toBe(2);

      const filtered = await app.inject({ method: "GET", url: "/api/batches?project_id=proj_other" });
      expect((filtered.json().batches as unknown[]).length).toBe(0);

      const missing = await app.inject({ method: "GET", url: "/api/batches/does-not-exist" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("allows manual server values while still keeping preset selections on queued folder runs", async () => {
    const stateFile = path.join(storageDir, "app-state.json");
    const scenario = createScenarioPackage({
      storageDir,
      projectId: "proj_demo",
      scenarioDirName: "server-placeholders-manual",
      folderPath: "suite_server_manual",
      scenarioName: "Server Placeholders Manual",
      inputs: [
        { name: "login_value", type: "string", description: "", otp_login: "" },
        { name: "password_value", type: "string", description: "", otp_login: "" },
        { name: "otp_value", type: "2fa_otp", description: "", otp_login: "" },
        { name: "merchant_value", type: "string", description: "", otp_login: "" }
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
              base_url: "https://example.com",
              is_default: true
            }
          ],
          accounts: [
            {
              login: "alice",
              password: "secret-pass",
              "2fa_otp": "JBSWY3DPEHPK3PXP",
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
          runs: []
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
        url: "/api/projects/proj_demo/folder-runs",
        payload: {
          folder_paths: ["suite_server_manual"],
          account_login: "alice",
          merchant_name: "acme",
          server_username: "manual-user",
          server_password: "manual-pass",
          server_2faotp: "123456",
          server_merchant: "manual-merchant",
          scenario_inputs: {
            [scenario.record.id]: {
              login_value: "{server_username}",
              password_value: "{server_password}",
              otp_value: "{server_2faotp}",
              merchant_value: "{server_merchant}"
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        account_login: "alice",
        merchant_name: "acme",
        server_username: "manual-user",
        server_password: "manual-pass",
        server_2faotp: "123456",
        server_merchant: "manual-merchant"
      });

      await vi.waitFor(() => {
        expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledTimes(1);
      });

      expect(runnerMocks.runScenarioInDocker).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: {
            login_value: "manual-user",
            password_value: "manual-pass",
            otp_value: "123456",
            merchant_value: "manual-merchant",
            server_username: "manual-user",
            server_password: "manual-pass",
            server_2faotp: "123456",
            server_merchant: "manual-merchant"
          },
          otp_secrets: {}
        })
      );

      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        runs: Array<{
          account_login: string | null;
          merchant_name: string | null;
          server_username: string | null;
          server_password: string | null;
          server_2faotp: string | null;
          server_merchant: string | null;
        }>;
      };
      expect(state.runs[0]).toMatchObject({
        account_login: "alice",
        merchant_name: "acme",
        server_username: "manual-user",
        server_password: "manual-pass",
        server_2faotp: "123456",
        server_merchant: "manual-merchant"
      });
    } finally {
      await app.close();
    }
  });
});

function writeStateFile(stateFile: string, scenarios: Array<Record<string, unknown>>): void {
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
            base_url: "https://example.com",
            is_default: true
          }
        ],
        accounts: [],
        merchants: [],
        scenarios,
        runs: []
      },
      null,
      2
    ),
    "utf8"
  );
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
        run_base_url: "https://example.com",
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
