import { describe, expect, it } from "vitest";
import { autoReplaceOtpFills, injectInputCalls, rewriteLegacyOtpPlaceholders } from "@ts-playwright/runner";

describe("runner source transforms", () => {
  it("injects input helper for placeholders", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.fill("#login", "{{INPUT:user_name}}");',
      "});"
    ].join("\n");

    const result = injectInputCalls(source);
    expect(result).toContain('import { test, expect, input } from "./pw-runtime";');
    expect(result).toContain('await page.fill("#login", input("user_name"));');
  });

  it("rewrites legacy otp placeholders", () => {
    const source = 'await page.fill("#otp", "OTP_CODE");';
    expect(rewriteLegacyOtpPlaceholders(source)).toContain("{{INPUT:2fa_otp}}");
  });

  it("auto replaces otp fills by selector hint", () => {
    const source = 'await page.locator("input.twoFactorAuthToken").fill("123456");';
    expect(autoReplaceOtpFills(source, true)).toContain('fill("{{INPUT:2fa_otp}}")');
  });
});
