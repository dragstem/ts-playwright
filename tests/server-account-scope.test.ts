import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Project-scoped accounts CRUD (Phase 2 / 2-R9): create global + scoped with the same login,
// filter by project, and delete each independently.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? String(raw[0]) : String(raw ?? "");
  return value.split(";")[0];
}

interface MaskedAccount {
  login: string;
  project_id: string | null;
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-scope-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { login: "admin@x.com", password: "supersecret1" } });
  cookie = cookieFrom(reg);
});

afterEach(async () => {
  await app?.close();
  if (prev.APP_STORAGE_DIR === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prev.APP_STORAGE_DIR;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("project-scoped accounts (2-R9)", () => {
  it("keeps a global and a project-scoped account with the same login distinct", async () => {
    const create = (project_id: string | null) =>
      app.inject({ method: "POST", url: "/api/accounts", headers: { cookie }, payload: { login: "alice", password: "pw", project_id } });

    expect((await create(null)).statusCode).toBe(200);
    expect((await create("proj_demo")).statusCode).toBe(200);

    const all = (await app.inject({ method: "GET", url: "/api/accounts", headers: { cookie } })).json() as MaskedAccount[];
    expect(all.filter((a) => a.login === "alice")).toHaveLength(2);

    // Filtering by project returns that project's account plus the global one.
    const scoped = (await app.inject({ method: "GET", url: "/api/accounts?project_id=proj_demo", headers: { cookie } })).json() as MaskedAccount[];
    expect(scoped.map((a) => a.project_id).sort()).toEqual([null, "proj_demo"]);

    // Deleting the scoped one leaves the global intact.
    const del = await app.inject({ method: "DELETE", url: "/api/accounts/alice?project_id=proj_demo", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/accounts", headers: { cookie } })).json() as MaskedAccount[];
    expect(after.filter((a) => a.login === "alice")).toHaveLength(1);
    expect(after.find((a) => a.login === "alice")?.project_id).toBeNull();
  });
});
