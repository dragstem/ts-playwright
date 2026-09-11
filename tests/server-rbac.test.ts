import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Global RBAC gate (Phase 3 / L3). These tests opt INTO enforcement (APP_REQUIRE_AUTH=1) — the rest
// of the suite runs with it disabled (vitest.config env) since those /api tests predate auth.
let app: FastifyInstance;
let storageDir = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-rbac-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  prev.APP_REQUIRE_AUTH = process.env.APP_REQUIRE_AUTH;
  prev.APP_API_KEY = process.env.APP_API_KEY;
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.APP_REQUIRE_AUTH = "1";
  process.env.APP_API_KEY = "machine-key-xyz";
  vi.resetModules();
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

describe("global RBAC gate (Phase 3 / L3)", () => {
  it("rejects an unauthenticated /api data request with 401", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("allows login and register without authentication", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "admin@example.com", password: "supersecret1" }
    });
    expect(reg.statusCode).toBe(200);
  });

  it("allows /api data requests with a valid session cookie", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "admin@example.com", password: "supersecret1" }
    });
    const cookie = cookieFrom(reg);
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("allows /api data requests with a valid PAT bearer token", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "admin@example.com", password: "supersecret1" }
    });
    const cookie = cookieFrom(reg);
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { cookie },
      payload: { label: "agent" }
    });
    const token = tokenRes.json().token as string;
    expect(token).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows /api data requests with the machine x-api-key", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { "x-api-key": "machine-key-xyz" }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong x-api-key with 401", async () => {
    const { createServer } = await import("../apps/server/src/app");
    app = createServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { "x-api-key": "wrong" }
    });
    expect(res.statusCode).toBe(401);
  });
});
