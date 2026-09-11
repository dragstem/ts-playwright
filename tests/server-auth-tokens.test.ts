import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorage: string | undefined;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-tokens-"));
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

describe("personal access tokens (Phase 2 / 2.8)", () => {
  it("issues a bearer token, authenticates with it, and revokes it", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "agent-user@x.com", password: "agentpass111" }
    });
    const cookie = cookieFrom(reg);

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { cookie },
      payload: { label: "my laptop" }
    });
    expect(created.statusCode).toBe(200);
    const token = created.json().token as string;
    const tokenId = created.json().id as string;
    expect(token).toMatch(/^tsp_/);

    // Bearer token authenticates /me (no cookie).
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().login).toBe("agent-user@x.com");

    // Listing never leaks the hash.
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).not.toHaveProperty("token_hash");

    // Revoke -> the bearer token stops working.
    const del = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${tokenId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });
});
