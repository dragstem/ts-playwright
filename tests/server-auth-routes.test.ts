import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let previousStorageDir: string | undefined;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-auth-routes-"));
  previousStorageDir = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (previousStorageDir === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = previousStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

describe("auth routes (Phase 2 / 2.3-2.4)", () => {
  it("runs the full register -> me -> login -> users -> logout flow", async () => {
    // First registration becomes admin and sets a session cookie.
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "Admin@example.com", password: "supersecret1", display_name: "Admin" }
    });
    expect(reg.statusCode).toBe(200);
    const adminUser = reg.json();
    expect(adminUser.role).toBe("admin");
    expect(adminUser.login).toBe("admin@example.com");
    expect(adminUser).not.toHaveProperty("password_hash");
    const adminCookie = cookieFrom(reg);
    expect(adminCookie).toMatch(/^ts_session=/);

    // /me requires the cookie.
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(adminUser.id);

    // Duplicate login is rejected.
    const dup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "admin@example.com", password: "anothersecret" }
    });
    expect(dup.statusCode).toBe(400);

    // Second user registers as operator.
    const reg2 = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "op@example.com", password: "operatorpass1" }
    });
    expect(reg2.statusCode).toBe(200);
    const opUser = reg2.json();
    expect(opUser.role).toBe("operator");
    const opCookie = cookieFrom(reg2);

    // Wrong password fails login; correct password succeeds.
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "op@example.com", password: "nope" } }))
        .statusCode
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "OP@example.com", password: "operatorpass1" }
    });
    expect(login.statusCode).toBe(200);

    // RBAC: operator cannot list users; admin can.
    expect((await app.inject({ method: "GET", url: "/api/auth/users", headers: { cookie: opCookie } })).statusCode).toBe(403);
    const users = await app.inject({ method: "GET", url: "/api/auth/users", headers: { cookie: adminCookie } });
    expect(users.statusCode).toBe(200);
    expect(users.json()).toHaveLength(2);

    // Admin cannot demote the last admin.
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/auth/users/${adminUser.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "operator" }
    });
    expect(demote.statusCode).toBe(400);

    // Admin can change the operator's role.
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/auth/users/${opUser.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "viewer" }
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe("viewer");

    // Logout invalidates the session.
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: adminCookie } });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } })).statusCode).toBe(401);
  });
});
