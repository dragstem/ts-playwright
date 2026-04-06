import { describe, expect, it } from "vitest";
import { generateTotpCode, generateTotpCodeSafe, generateTotpCodeSafeDetails, normalizeTotpSecret } from "@ts-playwright/shared";

describe("otp helpers", () => {
  it("rejects invalid secrets", () => {
    expect(() => normalizeTotpSecret("not-base32!")).toThrowError("OTP secret must be a valid base32 string");
  });

  it("matches a known vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(generateTotpCode(secret, { for_time: 59, digits: 6, period: 30 })).toBe("287082");
  });

  it("returns a six digit safe code", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const code = generateTotpCodeSafe(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns timing metadata for a safe code", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const details = generateTotpCodeSafeDetails(secret, { now: 29.2, period: 30, min_remaining: 20 });
    expect(details.code).toMatch(/^\d{6}$/);
    expect(details.period).toBe(30);
    expect(details.digits).toBe(6);
    expect(details.expires_in_sec).toBeGreaterThan(0);
    expect(details.for_time).toBeGreaterThan(30);
  });
});
