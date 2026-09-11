import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Stop mechanics (Phase 3 / 3.M9). Covers the endpoint contract: auth, 404, 409, and stopping a
// run that has no live container yet (queued/running but not executing). The actual docker kill
// path needs a live daemon and is exercised only in integration.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

function seedRun(status: string): void {
  const statePath = path.join(storageDir, "app-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.runs = [
    {
      id: "run-stop-1",
      scenario_id: "scn",
      triggered_by: "api",
      triggered_at: "2026-01-01T00:00:00.000Z",
      status
    }
  ];
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-stop-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
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

describe("run stop endpoint (Phase 3 / 3.M9)", () => {
  it("requires authentication", async () => {
    seedRun("running");
    const res = await app.inject({ method: "POST", url: "/api/runs/run-stop-1/stop" });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown run", async () => {
    const res = await app.inject({ method: "POST", url: "/api/runs/nope/stop", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("stops a running run and records outcome=stopped", async () => {
    seedRun("running");
    const res = await app.inject({ method: "POST", url: "/api/runs/run-stop-1/stop", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true, run_id: "run-stop-1" });

    const run = await app.inject({ method: "GET", url: "/api/runs/run-stop-1", headers: { cookie } });
    expect(run.statusCode).toBe(200);
    expect(run.json().outcome).toBe("stopped");
    expect(run.json().finished_at).toBeTruthy();
  });

  it("409s when the run already finished", async () => {
    seedRun("passed");
    const res = await app.inject({ method: "POST", url: "/api/runs/run-stop-1/stop", headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });
});
