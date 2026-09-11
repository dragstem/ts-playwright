import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server recent runs page", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-recent-runs-test-"));
    const artifactsDir = path.join(storageDir, "runs", "run-old");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "outputs.json"), JSON.stringify({ deposit_address: "TDepositAddress" }), "utf8");
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;
    writeFileSync(
      path.join(storageDir, "app-state.json"),
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
          scenarios: [
            {
              id: "scenario-old",
              project_id: "proj_demo",
              env_id: "staging",
              name: "Older Scenario",
              slug: "older_scenario",
              folder_path: "folder/a",
              created_by: "tester",
              created_at: "2026-01-01T00:00:00.000Z",
              package_path: "storage/projects/proj_demo/folder/a/scenario-old/package.zip",
              status: "active",
              inputs: []
            },
            {
              id: "scenario-new",
              project_id: "proj_demo",
              env_id: "staging",
              name: "Newest Scenario",
              slug: "newest_scenario",
              folder_path: "folder/b",
              created_by: "tester",
              created_at: "2026-01-01T00:00:00.000Z",
              package_path: "storage/projects/proj_demo/folder/b/scenario-new/package.zip",
              status: "active",
              inputs: []
            }
          ],
          runs: [
            {
              id: "run-old",
              scenario_id: "scenario-old",
              triggered_by: "api",
              triggered_at: "2026-01-01T10:00:00.000Z",
              batch_id: null,
              execution_stage: 1,
              status: "passed",
              started_at: "2026-01-01T10:00:10.000Z",
              finished_at: "2026-01-01T10:00:30.000Z",
              artifacts_path: artifactsDir,
              stdout_path: null,
              stderr_path: null,
              summary_json: null,
              inputs: { trace_id: "trace-123" },
              log_entries: []
            },
            {
              id: "run-new",
              scenario_id: "scenario-new",
              triggered_by: "api",
              triggered_at: "2026-01-01T11:00:00.000Z",
              batch_id: null,
              execution_stage: 1,
              status: "failed",
              started_at: "2026-01-01T11:00:10.000Z",
              finished_at: "2026-01-01T11:00:30.000Z",
              artifacts_path: null,
              stdout_path: null,
              stderr_path: null,
              summary_json: null,
              inputs: {},
              log_entries: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
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

  // The server-rendered recent-runs HTML page (/runs) was removed in Phase 3 / 3.15 (html.ts).
  // The SPA Runs screen renders this now; the JSON ordering contract stays covered below.

  it("returns recent runs from the api in descending order", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/runs"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        limit: null,
        runs: [
          {
            run: expect.objectContaining({
              id: "run-new",
              status: "failed"
            }),
            scenario: expect.objectContaining({
              id: "scenario-new",
              name: "Newest Scenario"
            }),
            trace_id: "",
            output_summary: ""
          },
          {
            run: expect.objectContaining({
              id: "run-old",
              status: "passed"
            }),
            scenario: expect.objectContaining({
              id: "scenario-old",
              name: "Older Scenario"
            }),
            trace_id: "trace-123",
            output_summary: "deposit_address: TDepositAddress"
          }
        ]
      });
    } finally {
      await app.close();
    }
  });
});
