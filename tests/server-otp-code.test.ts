import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server otp code api", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-otp-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousStorageDir === undefined) {
      delete process.env.APP_STORAGE_DIR;
    } else {
      process.env.APP_STORAGE_DIR = previousStorageDir;
    }
    vi.resetModules();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("returns a fresh otp code for a stored login", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const saveResponse = await app.inject({
        method: "POST",
        url: "/api/otp-accounts",
        payload: {
          login: "qa-admin",
          secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        }
      });

      expect(saveResponse.statusCode).toBe(200);

      const codeResponse = await app.inject({
        method: "POST",
        url: "/api/otp-accounts/code",
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

  it("returns not found for an unknown otp login", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/otp-accounts/code",
        payload: {
          login: "missing-user"
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("OTP account not found");
    } finally {
      await app.close();
    }
  });
});
