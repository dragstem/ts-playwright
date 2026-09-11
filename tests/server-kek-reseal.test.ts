import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStateSchema, generateKekMaterialBase64, generateTotpCode, isEncrypted } from "@ts-playwright/shared";
import { resealAppStateSecrets } from "../apps/server/src/reseal";
import { AuthStore } from "../apps/server/src/auth/store";

const prevKek = process.env.APP_KEK;

beforeEach(() => {
  process.env.APP_KEK = generateKekMaterialBase64();
});

afterEach(() => {
  if (prevKek === undefined) delete process.env.APP_KEK;
  else process.env.APP_KEK = prevKek;
});

describe("KEK lifecycle / reseal (2-R8)", () => {
  it("encrypts plaintext account & project-var secrets under the configured KEK", () => {
    const state = AppStateSchema.parse({
      accounts: [
        { login: "alice", password: "plain-pass", "2fa_otp": "JBSWY3DPEHPK3PXP", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }
      ],
      project_server_vars: [
        { project_id: "proj_demo", server_password: "plain-server-pass", server_2faotp: "", extra: {}, created_at: "", updated_at: "" }
      ]
    });

    const { report } = resealAppStateSecrets(state);
    expect(report.encryption_enabled).toBe(true);
    expect(report.account_secrets).toBe(2); // password + 2fa_otp
    expect(report.project_var_secrets).toBe(1); // only the non-empty password
    expect(isEncrypted(state.accounts[0].password)).toBe(true);
    expect(isEncrypted(state.accounts[0]["2fa_otp"])).toBe(true);
    expect(isEncrypted(state.project_server_vars[0].server_password)).toBe(true);

    // Re-running is a no-op: values are already sealed under the current key.
    const second = resealAppStateSecrets(state);
    expect(second.report.total).toBe(0);
  });

  it("stores the MFA secret encrypted at rest but still verifies codes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-kek-"));
    try {
      const store = new AuthStore(dir);
      const user = store.createUser({ login: "admin@x.com", password: "supersecret1" });
      const enrollment = store.beginMfaEnrollment(user.id);
      if (!enrollment) {
        throw new Error("enrollment failed");
      }
      const confirmed = store.confirmMfaEnrollment(user.id, generateTotpCode(enrollment.secret));
      expect(confirmed).not.toBeNull();

      // On disk, the secret is an enc:v1 record, not the base32 plaintext.
      const users = JSON.parse(readFileSync(path.join(dir, "users.json"), "utf8")) as { mfa_secret: string }[];
      expect(isEncrypted(users[0].mfa_secret)).toBe(true);

      // Verification still works (the store opens it with the KEK).
      expect(store.verifyMfaCode(user.id, generateTotpCode(enrollment.secret))).toBe(true);
      // Already sealed under the current key → reseal changes nothing.
      expect(store.resealMfaSecrets()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
