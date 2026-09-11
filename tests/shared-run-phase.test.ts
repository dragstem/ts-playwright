import { describe, expect, it } from "vitest";
import { RunSchema } from "@ts-playwright/shared";

const base = {
  id: "run_1",
  scenario_id: "scn_1",
  triggered_by: "test",
  triggered_at: "2026-01-01T00:00:00.000Z",
  status: "queued" as const
};

describe("run phase fields (Phase 3 / 2-R11)", () => {
  it("defaults phase to queued, phase_timings to empty, outcome absent", () => {
    const run = RunSchema.parse({ ...base });
    expect(run.phase).toBe("queued");
    expect(run.phase_timings).toEqual({});
    expect(run.outcome).toBeUndefined();
  });

  it("accepts populated phase/outcome/timings and defaults timing.status to active", () => {
    const run = RunSchema.parse({
      ...base,
      status: "passed",
      phase: "done",
      outcome: "passed",
      phase_timings: {
        prepare: { started_at: "t", duration_ms: 100, status: "done" },
        execute: { started_at: "t" }
      }
    });
    expect(run.phase).toBe("done");
    expect(run.outcome).toBe("passed");
    expect(run.phase_timings.prepare.duration_ms).toBe(100);
    expect(run.phase_timings.execute.status).toBe("active");
    expect(run.phase_timings.execute.duration_ms).toBeNull();
  });

  it("rejects an unknown phase", () => {
    expect(() => RunSchema.parse({ ...base, phase: "nope" })).toThrow();
  });
});
