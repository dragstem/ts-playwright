import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTotpCode } from "@ts-playwright/shared";
import type { FastifyInstance } from "fastify";

// Login MFA (Phase 2 / 2-R6): enroll → confirm → password+TOTP login → recovery code → disable.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};
const LOGIN = "admin@example.com";
const PASSWORD = "supersecret1";

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

async function enableMfa(): Promise<{ secret: string; recovery: string[] }> {
  const enroll = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll", headers: { cookie } });
  expect(enroll.statusCode).toBe(200);
  const secret = enroll.json().secret as string;
  const confirm = await app.inject({
    method: "POST",
    url: "/api/auth/mfa/confirm",
    headers: { cookie },
    payload: { code: generateTotpCode(secret) }
  });
  expect(confirm.statusCode).toBe(200);
  return { secret, recovery: confirm.json().recovery_codes as string[] };
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-mfa-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { login: LOGIN, password: PASSWORD } });
  cookie = cookieFrom(reg);
});

afterEach(async () => {
  await app?.close();
  if (prev.APP_STORAGE_DIR === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prev.APP_STORAGE_DIR;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("login MFA (Phase 2 / 2-R6)", () => {
  it("enrolls and flips mfa_enabled on, returning recovery codes", async () => {
    const { recovery } = await enableMfa();
    expect(recovery).toHaveLength(8);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().mfa_enabled).toBe(true);
  });

  it("rejects enrollment confirmation with a wrong code", async () => {
    await app.inject({ method: "POST", url: "/api/auth/mfa/enroll", headers: { cookie } });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/confirm",
      headers: { cookie },
      payload: { code: "000000" }
    });
    expect(confirm.statusCode).toBe(400);
  });

  it("requires a TOTP code on login once MFA is enabled", async () => {
    const { secret } = await enableMfa();

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: LOGIN, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa_required).toBe(true);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const mfaToken = login.json().mfa_token as string;

    const bad = await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { mfa_token: mfaToken, code: "000000" } });
    expect(bad.statusCode).toBe(401);

    // The bad attempt consumed the challenge, so a fresh login is needed for the good attempt.
    const login2 = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: LOGIN, password: PASSWORD } });
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { mfa_token: login2.json().mfa_token, code: generateTotpCode(secret) }
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieFrom(ok)).toContain("=");
  });

  it("accepts a one-time recovery code at login", async () => {
    const { recovery } = await enableMfa();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: LOGIN, password: PASSWORD } });
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { mfa_token: login.json().mfa_token, code: recovery[0] }
    });
    expect(ok.statusCode).toBe(200);

    // The same recovery code cannot be reused.
    const login2 = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: LOGIN, password: PASSWORD } });
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { mfa_token: login2.json().mfa_token, code: recovery[0] }
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("disables MFA with a valid code and returns to single-factor login", async () => {
    const { secret } = await enableMfa();
    const disable = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: { cookie },
      payload: { code: generateTotpCode(secret) }
    });
    expect(disable.statusCode).toBe(200);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: LOGIN, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa_required).toBeUndefined();
    expect(cookieFrom(login)).toContain("=");
  });
});
