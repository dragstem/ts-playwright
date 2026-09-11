import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server account 2fa api", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;
  let previousOtpAccountsJson: string | undefined;
  let previousAccountsJson: string | undefined;
  let previousMerchantsJson: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-otp-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    previousOtpAccountsJson = process.env.APP_OTP_ACCOUNTS_JSON;
    previousAccountsJson = process.env.APP_ACCOUNTS_JSON;
    previousMerchantsJson = process.env.APP_MERCHANTS_JSON;
    process.env.APP_STORAGE_DIR = storageDir;
    delete process.env.APP_OTP_ACCOUNTS_JSON;
    delete process.env.APP_ACCOUNTS_JSON;
    delete process.env.APP_MERCHANTS_JSON;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousStorageDir === undefined) {
      delete process.env.APP_STORAGE_DIR;
    } else {
      process.env.APP_STORAGE_DIR = previousStorageDir;
    }
    if (previousOtpAccountsJson === undefined) {
      delete process.env.APP_OTP_ACCOUNTS_JSON;
    } else {
      process.env.APP_OTP_ACCOUNTS_JSON = previousOtpAccountsJson;
    }
    if (previousAccountsJson === undefined) {
      delete process.env.APP_ACCOUNTS_JSON;
    } else {
      process.env.APP_ACCOUNTS_JSON = previousAccountsJson;
    }
    if (previousMerchantsJson === undefined) {
      delete process.env.APP_MERCHANTS_JSON;
    } else {
      process.env.APP_MERCHANTS_JSON = previousMerchantsJson;
    }
    vi.resetModules();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("returns a fresh otp code for a stored account", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/accounts",
        payload: {
          login: "qa-admin",
          password: "secret-pass",
          "2fa_otp": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        }
      });

      expect(saveResponse.statusCode).toBe(200);

      const codeResponse = await app.inject({
        method: "POST",
        url: "/api/accounts/code",
        payload: {
          login: "qa-admin"
        }
      });

      expect(codeResponse.statusCode).toBe(200);
      expect(codeResponse.json()).toMatchObject({
        login: "qa-admin",
        period: 30,
        digits: 6
      });
      expect(codeResponse.json().code).toMatch(/^\d{6}$/);
      expect(codeResponse.json().expires_in_sec).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("returns not found for an unknown account", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/accounts/code",
        payload: {
          login: "missing-user"
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Account not found");
    } finally {
      await app.close();
    }
  });

  it("rejects otp generation when account 2fa is not configured", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/accounts",
        payload: {
          login: "qa-admin",
          password: "secret-pass",
          "2fa_otp": ""
        }
      });

      expect(saveResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: "/api/accounts/code",
        payload: {
          login: "qa-admin"
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("does not have 2FA OTP configured");
    } finally {
      await app.close();
    }
  });

  it("creates, lists, and deletes server accounts", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/accounts",
        payload: {
          login: "alice",
          password: "secret-pass",
          "2fa_otp": "JBSWY3DPEHPK3PXP"
        }
      });

      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toMatchObject({
        login: "alice",
        password: "secret-pass",
        "2fa_otp": "JBSWY3DPEHPK3PXP"
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/accounts"
      });

      expect(listResponse.statusCode).toBe(200);
      // Write-only API: masked flags, never the secret values (Phase 3 / 3.8).
      expect(listResponse.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ login: "alice", has_password: true, has_totp: true })])
      );
      expect(listResponse.body).not.toContain("secret-pass");
      expect(listResponse.body).not.toContain("JBSWY3DPEHPK3PXP");

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/api/accounts/alice"
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({
        deleted: true,
        login: "alice"
      });
    } finally {
      await app.close();
    }
  });

  it("creates, lists, and deletes merchants", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/merchants",
        payload: {
          name: "acme"
        }
      });

      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toMatchObject({
        name: "acme"
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/merchants"
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "acme"
          })
        ])
      );

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/api/merchants/acme"
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({
        deleted: true,
        name: "acme"
      });
    } finally {
      await app.close();
    }
  });

  it("imports seeded entities from env json variables on startup", async () => {
    process.env.APP_ACCOUNTS_JSON =
      '[{"login":"env-user","password":"env-pass","2fa_otp":"JBSWY3DPEHPK3PXP"}]';
    process.env.APP_MERCHANTS_JSON = '[{"name":"env-merchant"}]';

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const accountsListResponse = await app.inject({
        method: "GET",
        url: "/api/accounts"
      });
      const merchantsListResponse = await app.inject({
        method: "GET",
        url: "/api/merchants"
      });

      expect(accountsListResponse.statusCode).toBe(200);
      expect(merchantsListResponse.statusCode).toBe(200);
      expect(accountsListResponse.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ login: "env-user", has_password: true, has_totp: true })])
      );
      expect(accountsListResponse.body).not.toContain("env-pass");
      expect(merchantsListResponse.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "env-merchant" })])
      );
    } finally {
      await app.close();
    }
  });

  it("stores accounts and merchants in tracked storage json files", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const accountResponse = await app.inject({
        method: "POST",
        url: "/api/accounts",
        payload: {
          login: "git-user",
          password: "git-pass",
          "2fa_otp": "JBSWY3DPEHPK3PXP"
        }
      });
      const merchantResponse = await app.inject({
        method: "POST",
        url: "/api/merchants",
        payload: {
          name: "git-merchant"
        }
      });

      expect(accountResponse.statusCode).toBe(200);
      expect(merchantResponse.statusCode).toBe(200);

      const accountsFile = path.join(storageDir, "accounts.json");
      const merchantsFile = path.join(storageDir, "merchants.json");

      expect(existsSync(accountsFile)).toBe(true);
      expect(existsSync(merchantsFile)).toBe(true);
      expect(JSON.parse(readFileSync(accountsFile, "utf8"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            login: "git-user",
            password: "git-pass",
            "2fa_otp": "JBSWY3DPEHPK3PXP"
          })
        ])
      );
      expect(JSON.parse(readFileSync(merchantsFile, "utf8"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "git-merchant"
          })
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("migrates legacy otp env config into account 2fa secret", async () => {
    process.env.APP_OTP_ACCOUNTS_JSON = '[{"login":"env-otp","secret":"JBSWY3DPEHPK3PXP"}]';
    process.env.APP_ACCOUNTS_JSON = '[{"login":"env-user","password":"env-pass","2fa_otp":"env-otp"}]';

    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const accountsListResponse = await app.inject({
        method: "GET",
        url: "/api/accounts"
      });

      expect(accountsListResponse.statusCode).toBe(200);
      expect(accountsListResponse.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ login: "env-user", has_password: true, has_totp: true })])
      );
      expect(accountsListResponse.body).not.toContain("env-pass");
    } finally {
      await app.close();
    }
  });
});
