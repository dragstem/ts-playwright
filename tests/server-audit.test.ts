import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorage: string | undefined;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-audit-"));
  prevStorage = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (prevStorage === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorage;
  rmSync(storageDir, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

describe("audit log (Phase 2 / 2.7)", () => {
  it("records auth events and exposes them to admins only", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "admin@x.com", password: "adminpass11" }
    });
    const adminCookie = cookieFrom(reg);

    const op = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "op@x.com", password: "operatorpass1" }
    });
    const opCookie = cookieFrom(op);

    await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "op@x.com", password: "wrong" } });

    // operator may not read the audit log
    expect((await app.inject({ method: "GET", url: "/api/auth/audit", headers: { cookie: opCookie } })).statusCode).toBe(
      403
    );

    const audit = await app.inject({ method: "GET", url: "/api/auth/audit", headers: { cookie: adminCookie } });
    expect(audit.statusCode).toBe(200);
    const actions = (audit.json() as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain("user.register");
    expect(actions).toContain("user.login_failed");
    // newest first
    expect(actions[0]).toBe("user.login_failed");
  });
});
