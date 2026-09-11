import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Batch bulk actions (Phase 3 / 2-R11): stop every active member, retry every failed/errored member
// into the same batch. Runner is mocked so retried members never reach docker.
const runnerMocks = vi.hoisted(() => ({ runScenarioInDocker: vi.fn() }));
vi.mock("@ts-playwright/runner", () => ({
  detectForeignDomains: () => [],
  runScenarioInDocker: runnerMocks.runScenarioInDocker
}));

let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

interface MemberSeed {
  id: string;
  status: string;
  outcome?: string | null;
}

function seedBatch(members: MemberSeed[]): void {
  const statePath = path.join(storageDir, "app-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.projects = [{ id: "proj_demo", name: "Demo" }];
  state.environments = [
    { id: "staging", project_id: "proj_demo", name: "staging", base_url: "https://example.com", is_default: true }
  ];
  state.scenarios = [
    {
      id: "scn-a",
      project_id: "proj_demo",
      env_id: "staging",
      name: "A",
      slug: "a",
      folder_path: "suite/a",
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      // Absolute path under the temp storage dir so retried runs write artifacts there, not into
      // the repo working tree.
      package_path: path.join(storageDir, "suite", "a", "package.zip"),
      status: "active",
      inputs: []
    }
  ];
  state.runs = members.map((member, index) => ({
    id: member.id,
    scenario_id: "scn-a",
    env_id: "staging",
    triggered_by: "api",
    triggered_at: "2026-01-01T00:00:00.000Z",
    batch_id: "batch-1",
    execution_stage: 1,
    run_iteration: index + 1,
    amount_times_to_run: members.length,
    status: member.status,
    outcome: member.outcome ?? null
  }));
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-batch-actions-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  runnerMocks.runScenarioInDocker.mockReset();
  runnerMocks.runScenarioInDocker.mockImplementation(
    async ({ artifacts_dir }: { artifacts_dir: string }) => ({
      status: "passed",
      artifacts_path: artifacts_dir,
      stdout_path: path.join(artifacts_dir, "stdout.log"),
      stderr_path: path.join(artifacts_dir, "stderr.log"),
      summary_json: JSON.stringify({ status: "passed" })
    })
  );
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { login: "admin@example.com", password: "supersecret1" }
  });
  cookie = cookieFrom(reg);
});

afterEach(async () => {
  await app?.close();
  if (prev.APP_STORAGE_DIR === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prev.APP_STORAGE_DIR;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("batch bulk actions (Phase 3 / 2-R11)", () => {
  it("requires authentication", async () => {
    seedBatch([{ id: "r1", status: "running" }]);
    const stop = await app.inject({ method: "POST", url: "/api/batches/batch-1/stop" });
    expect(stop.statusCode).toBe(401);
    const retry = await app.inject({ method: "POST", url: "/api/batches/batch-1/retry-failed" });
    expect(retry.statusCode).toBe(401);
    const complete = await app.inject({ method: "POST", url: "/api/batches/batch-1/complete" });
    expect(complete.statusCode).toBe(401);
  });

  it("404s for an unknown batch", async () => {
    seedBatch([{ id: "r1", status: "running" }]);
    const stop = await app.inject({ method: "POST", url: "/api/batches/nope/stop", headers: { cookie } });
    expect(stop.statusCode).toBe(404);
  });

  it("stops only the active members and records them as stopped", async () => {
    seedBatch([
      { id: "r-running", status: "running" },
      { id: "r-queued", status: "queued" },
      { id: "r-passed", status: "passed", outcome: "passed" }
    ]);

    const stop = await app.inject({ method: "POST", url: "/api/batches/batch-1/stop", headers: { cookie } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ batch_id: "batch-1", stopped: 2 });

    const detail = await app.inject({ method: "GET", url: "/api/batches/batch-1", headers: { cookie } });
    const runsById = new Map(
      (detail.json().runs as Array<{ id: string; outcome: string | null }>).map((run) => [run.id, run.outcome])
    );
    expect(runsById.get("r-running")).toBe("stopped");
    expect(runsById.get("r-queued")).toBe("stopped");
    expect(runsById.get("r-passed")).toBe("passed");
  });

  it("retries failed and errored members into the same batch, skipping stopped ones", async () => {
    seedBatch([
      { id: "r-failed", status: "failed", outcome: "failed" },
      { id: "r-error", status: "error", outcome: "error" },
      { id: "r-stopped", status: "error", outcome: "stopped" },
      { id: "r-passed", status: "passed", outcome: "passed" }
    ]);

    const retry = await app.inject({ method: "POST", url: "/api/batches/batch-1/retry-failed", headers: { cookie } });
    expect(retry.statusCode).toBe(200);
    const body = retry.json() as { retried: number; runs: Array<{ batch_id: string; retry_of_run_id: string }> };
    expect(body.retried).toBe(2);
    expect(body.runs.every((run) => run.batch_id === "batch-1")).toBe(true);
    expect(body.runs.map((run) => run.retry_of_run_id).sort()).toEqual(["r-error", "r-failed"]);

    // The fresh attempts join the batch: 4 originals + 2 retries.
    await vi.waitFor(async () => {
      const detail = await app.inject({ method: "GET", url: "/api/batches/batch-1", headers: { cookie } });
      expect(detail.json().total).toBe(6);
    });
  });

  it("tops up a batch to the target number of passed runs", async () => {
    // amount_times_to_run is seeded as the member count (4), so the target is 4 passed.
    seedBatch([
      { id: "p1", status: "passed", outcome: "passed" },
      { id: "p2", status: "passed", outcome: "passed" },
      { id: "f1", status: "failed", outcome: "failed" },
      { id: "s1", status: "error", outcome: "stopped" }
    ]);

    const res = await app.inject({ method: "POST", url: "/api/batches/batch-1/complete", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: number; runs: Array<{ batch_id: string }> };
    // target 4 - 2 passed = 2 fresh runs.
    expect(body.added).toBe(2);
    expect(body.runs.every((run) => run.batch_id === "batch-1")).toBe(true);

    // Mocked runner passes the fresh runs, so the batch ends with the 4 originals + 2 top-ups.
    await vi.waitFor(async () => {
      const detail = await app.inject({ method: "GET", url: "/api/batches/batch-1", headers: { cookie } });
      expect(detail.json().total).toBe(6);
    });
  });

  it("is a no-op when the batch already has enough passed runs", async () => {
    seedBatch([
      { id: "p1", status: "passed", outcome: "passed" },
      { id: "p2", status: "passed", outcome: "passed" },
      { id: "p3", status: "passed", outcome: "passed" },
      { id: "p4", status: "passed", outcome: "passed" }
    ]);

    const res = await app.inject({ method: "POST", url: "/api/batches/batch-1/complete", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(0);
  });
});
