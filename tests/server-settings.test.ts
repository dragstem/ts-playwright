import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Runtime execution settings (max concurrent runner containers), Phase 3 — GET/PUT /api/settings.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : (raw ?? "")).split(";")[0];
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-settings-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  prev.APP_MAX_CONCURRENT_RUNS = process.env.APP_MAX_CONCURRENT_RUNS;
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.APP_MAX_CONCURRENT_RUNS = "2";
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { login: "admin@x.com", password: "supersecret1" } });
  cookie = cookieFrom(reg);
});

afterEach(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("runtime settings (/api/settings)", () => {
  it("reports the default concurrency and updates it", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/settings" });
    expect(initial.json().max_concurrent_runs).toBe(2);

    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { max_concurrent_runs: 5 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().max_concurrent_runs).toBe(5);

    const after = await app.inject({ method: "GET", url: "/api/settings" });
    expect(after.json().max_concurrent_runs).toBe(5);
  });

  it("clamps invalid values to at least 1", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { max_concurrent_runs: 0 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().max_concurrent_runs).toBeGreaterThanOrEqual(1);
  });
});
