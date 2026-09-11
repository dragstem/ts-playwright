import { describe, expect, it } from "vitest";
import { AppStateSchema, type RunStatus } from "@ts-playwright/shared";
import { summarizeBatch, summarizeBatches } from "../apps/server/src/batches";

interface RunSeed {
  id: string;
  batch_id?: string | null;
  scenario_id?: string;
  status: RunStatus;
  outcome?: string | null;
  execution_stage?: number;
  run_iteration?: number;
  triggered_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

function stateWith(runs: RunSeed[]) {
  return AppStateSchema.parse({
    projects: [{ id: "proj_demo", name: "Demo" }],
    scenarios: [
      {
        id: "scenario-a",
        project_id: "proj_demo",
        env_id: "staging",
        name: "A",
        slug: "a",
        folder_path: "suite/a",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/a/package.zip",
        status: "active",
        inputs: []
      },
      {
        id: "scenario-b",
        project_id: "proj_other",
        env_id: "staging",
        name: "B",
        slug: "b",
        folder_path: "suite/b",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/b/package.zip",
        status: "active",
        inputs: []
      }
    ],
    runs: runs.map((seed) => ({
      id: seed.id,
      scenario_id: seed.scenario_id ?? "scenario-a",
      triggered_by: "api",
      triggered_at: seed.triggered_at ?? "2026-02-01T00:00:00.000Z",
      batch_id: seed.batch_id ?? null,
      execution_stage: seed.execution_stage ?? 1,
      run_iteration: seed.run_iteration ?? 1,
      amount_times_to_run: 3,
      status: seed.status,
      outcome: seed.outcome ?? null,
      started_at: seed.started_at ?? null,
      finished_at: seed.finished_at ?? null
    }))
  });
}

describe("batch aggregation (2-R11)", () => {
  it("aggregates a finished batch with mixed results as partial", () => {
    const state = stateWith([
      { id: "r1", batch_id: "batch-1", status: "passed", outcome: "passed", run_iteration: 1, finished_at: "2026-02-01T00:01:00.000Z", started_at: "2026-02-01T00:00:30.000Z" },
      { id: "r2", batch_id: "batch-1", status: "failed", outcome: "failed", run_iteration: 2, finished_at: "2026-02-01T00:02:00.000Z", started_at: "2026-02-01T00:00:40.000Z" },
      { id: "r3", batch_id: "batch-1", status: "error", outcome: "timeout", run_iteration: 3, finished_at: "2026-02-01T00:01:30.000Z", started_at: "2026-02-01T00:00:50.000Z" }
    ]);

    const batch = summarizeBatch(state, "batch-1");
    expect(batch).not.toBeNull();
    expect(batch?.total).toBe(3);
    expect(batch?.done).toBe(3);
    expect(batch?.in_progress).toBe(false);
    expect(batch?.status).toBe("partial");
    expect(batch?.counts).toMatchObject({ passed: 1, failed: 1, error: 1, queued: 0, running: 0 });
    expect(batch?.outcomes).toMatchObject({ passed: 1, failed: 1, timeout: 1 });
    expect(batch?.project_id).toBe("proj_demo");
    // All members finished, so finished_at is the latest member finish.
    expect(batch?.finished_at).toBe("2026-02-01T00:02:00.000Z");
    // Runs are ordered by stage then iteration.
    expect(batch?.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    // Each member run carries its scenario's name for the batch screen.
    expect(batch?.runs[0]?.scenario_name).toBe("A");
  });

  it("keeps an in-progress batch as running with no finished_at", () => {
    const state = stateWith([
      { id: "r1", batch_id: "batch-2", status: "passed", outcome: "passed", finished_at: "2026-02-01T00:01:00.000Z" },
      { id: "r2", batch_id: "batch-2", status: "running" },
      { id: "r3", batch_id: "batch-2", status: "queued" }
    ]);

    const batch = summarizeBatch(state, "batch-2");
    expect(batch?.status).toBe("running");
    expect(batch?.in_progress).toBe(true);
    expect(batch?.done).toBe(1);
    expect(batch?.finished_at).toBeNull();
  });

  it("reports an all-passed batch as passed and an all-failed batch as failed", () => {
    const passedState = stateWith([
      { id: "p1", batch_id: "ok", status: "passed", outcome: "passed", finished_at: "2026-02-01T00:01:00.000Z" },
      { id: "p2", batch_id: "ok", status: "passed", outcome: "passed", finished_at: "2026-02-01T00:01:10.000Z" }
    ]);
    expect(summarizeBatch(passedState, "ok")?.status).toBe("passed");

    const failedState = stateWith([
      { id: "f1", batch_id: "bad", status: "failed", outcome: "failed", finished_at: "2026-02-01T00:01:00.000Z" },
      { id: "f2", batch_id: "bad", status: "error", outcome: "error", finished_at: "2026-02-01T00:01:10.000Z" }
    ]);
    expect(summarizeBatch(failedState, "bad")?.status).toBe("failed");
  });

  it("returns null for an unknown batch", () => {
    expect(summarizeBatch(stateWith([]), "nope")).toBeNull();
  });

  it("lists batches newest-first and ignores runs without a batch_id", () => {
    const state = stateWith([
      { id: "a1", batch_id: "old", status: "passed", outcome: "passed", triggered_at: "2026-02-01T00:00:00.000Z" },
      { id: "b1", batch_id: "new", status: "running", triggered_at: "2026-02-02T00:00:00.000Z" },
      { id: "solo", batch_id: null, status: "passed", outcome: "passed", triggered_at: "2026-02-03T00:00:00.000Z" }
    ]);

    const batches = summarizeBatches(state);
    expect(batches.map((b) => b.batch_id)).toEqual(["new", "old"]);

    const limited = summarizeBatches(state, 1);
    expect(limited.map((b) => b.batch_id)).toEqual(["new"]);
  });
});
