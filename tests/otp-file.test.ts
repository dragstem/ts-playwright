import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOtpCodeFromFile, loadTotpSecretsFile, parseTotpSecretsDocument } from "@ts-playwright/shared";

describe("otp secrets file helpers", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-otp-file-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses text documents with login=secret rows", () => {
    const parsed = parseTotpSecretsDocument(`
      # comment
      qa-admin=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
      qa-manager: JBSWY3DPEHPK3PXP
    `);

    expect(parsed).toEqual({
      "qa-admin": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      "qa-manager": "JBSWY3DPEHPK3PXP"
    });
  });

  it("loads json documents with nested secret objects", async () => {
    const filePath = path.join(tempDir, "totp-secrets.json");
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          "qa-admin": { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
          "qa-manager": "JBSWY3DPEHPK3PXP"
        },
        null,
        2
      ),
      "utf8"
    );

    const parsed = await loadTotpSecretsFile(filePath);
    expect(parsed["qa-admin"]).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(parsed["qa-manager"]).toBe("JBSWY3DPEHPK3PXP");
  });

  it("returns a fresh code for a login from a secrets file", async () => {
    const filePath = path.join(tempDir, "totp-secrets.txt");
    writeFileSync(filePath, "qa-admin=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n", "utf8");

    const otp = await getOtpCodeFromFile("qa-admin", filePath);
    expect(otp.login).toBe("qa-admin");
    expect(otp.code).toMatch(/^\d{6}$/);
    expect(otp.expires_in_sec).toBeGreaterThan(0);
  });
});
