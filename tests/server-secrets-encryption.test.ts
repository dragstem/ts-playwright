import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorage: string | undefined;
let prevKek: string | undefined;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-enc-"));
  prevStorage = process.env.APP_STORAGE_DIR;
  prevKek = process.env.APP_KEK;
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.APP_KEK = Buffer.alloc(32, 7).toString("base64"); // valid 32-byte KEK
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (prevStorage === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorage;
  if (prevKek === undefined) delete process.env.APP_KEK;
  else process.env.APP_KEK = prevKek;
  rmSync(storageDir, { recursive: true, force: true });
});

describe("stand-credential encryption at rest (Phase 2 / 2.2)", () => {
  it("stores secrets encrypted and still resolves a fresh OTP code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { login: "enc-admin", password: "plain-pass-1", "2fa_otp": "JBSWY3DPEHPK3PXP" }
    });
    expect(res.statusCode).toBe(200);

    const stored = JSON.parse(readFileSync(path.join(storageDir, "accounts.json"), "utf8")) as Array<{
      login: string;
      password: string;
      "2fa_otp": string;
    }>;
    const account = stored.find((a) => a.login === "enc-admin");
    expect(account).toBeTruthy();
    // Secrets are envelope-encrypted on disk, not plaintext.
    expect(account?.password).toMatch(/^enc:v1:/);
    expect(account?.password).not.toContain("plain-pass-1");
    expect(account?.["2fa_otp"]).toMatch(/^enc:v1:/);
    expect(account?.["2fa_otp"]).not.toContain("JBSWY3DPEHPK3PXP");

    // The on-demand OTP endpoint decrypts the secret and produces a 6-digit code.
    const code = await app.inject({ method: "POST", url: "/api/accounts/code", payload: { login: "enc-admin" } });
    expect(code.statusCode).toBe(200);
    expect(code.json().code).toMatch(/^\d{6}$/);
  });
});
