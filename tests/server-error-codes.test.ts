import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Structured error responses (Phase 3 / 3.M8): 4xx bodies carry { error, code } so the client can
// localize by code and fall back to the message.
let app: FastifyInstance;
let storageDir = "";
const prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-errcode-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  if (prev.APP_STORAGE_DIR === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prev.APP_STORAGE_DIR;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("structured error codes (3.M8)", () => {
  it("returns { error, code } for a missing scenario", async () => {
    const res = await app.inject({ method: "GET", url: "/api/scenarios/nope" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; code: string | null };
    expect(body.code).toBe("scenario.not_found");
    expect(body.error).toBe("Scenario not found");
  });

  it("tags invalid credentials with an auth code", async () => {
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { login: "a@x.com", password: "supersecret1" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "a@x.com", password: "wrongpass" } });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe("auth.invalid_credentials");
  });
});
