import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Crash recovery on startup (Phase 3 / 2-R3 foundation). Runs left queued/running by a previous
// process are finalized as outcome=interrupted so they don't appear stuck forever.
let app: FastifyInstance;
let storageDir = "";
let prevStorageDir: string | undefined;

function run(id: string, status: string) {
  return { id, scenario_id: "scn", triggered_by: "api", triggered_at: "2026-01-01T00:00:00.000Z", status };
}

beforeEach(() => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-recovery-"));
  prevStorageDir = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  writeFileSync(
    path.join(storageDir, "app-state.json"),
    JSON.stringify({ runs: [run("r-running", "running"), run("r-queued", "queued"), run("r-passed", "passed")] }),
    "utf8"
  );
  vi.resetModules();
});

afterEach(async () => {
  await app?.close();
  if (prevStorageDir === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorageDir;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("orphaned run recovery (Phase 3 / 2-R3)", () => {
  it("interrupts queued/running runs on startup, leaves finished runs alone", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    await app.ready();

    const list = await app.inject({ method: "GET", url: "/api/runs" });
    expect(list.statusCode).toBe(200);
    const byId = new Map(
      (list.json().runs as Array<{ run: { id: string; status: string; outcome?: string } }>).map((r) => [r.run.id, r.run])
    );

    expect(byId.get("r-running")?.status).toBe("error");
    expect(byId.get("r-running")?.outcome).toBe("interrupted");
    expect(byId.get("r-queued")?.status).toBe("error");
    expect(byId.get("r-queued")?.outcome).toBe("interrupted");
    // A finished run is untouched.
    expect(byId.get("r-passed")?.status).toBe("passed");
    expect(byId.get("r-passed")?.outcome).not.toBe("interrupted");
  });
});
