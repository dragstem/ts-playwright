import { describe, expect, it } from "vitest";
import { hashPassword, isPasswordHash, verifyPassword } from "@ts-playwright/shared";

describe("password hashing (Phase 2 / 2.3)", () => {
  it("hashes and verifies a password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(isPasswordHash(hash)).toBe(true);
    expect(hash).toMatch(/^scrypt:\d+:\d+:\d+:/);
    expect(hash).not.toContain("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("right");
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("uses a unique salt per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored values", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "notascrypt:hash")).toBe(false);
    expect(verifyPassword("x", "scrypt:bad:8:1:AAAA:AAAA")).toBe(false);
  });

  it("throws on an empty password", () => {
    expect(() => hashPassword("")).toThrow();
  });
});
