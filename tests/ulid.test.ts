import { describe, expect, it } from "vitest";
import { generateUlid, isUlid } from "@ts-playwright/shared";

describe("ULID (2-R4)", () => {
  it("generates 26-char Crockford base32 ids", () => {
    const ulid = generateUlid();
    expect(ulid).toHaveLength(26);
    expect(isUlid(ulid)).toBe(true);
  });

  it("is lexicographically sortable by time", () => {
    const earlier = generateUlid(1_000_000_000_000);
    const later = generateUlid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
    // The 10-char timestamp prefix is monotonic with time.
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });

  it("rejects non-ULID strings", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("0123456789ILOU234567890123")).toBe(false); // 26 chars but uses excluded letters I/L/O/U
    expect(isUlid("0123")).toBe(false); // too short
    expect(isUlid("")).toBe(false);
    expect(isUlid(123)).toBe(false);
  });

  it("accepts a known-valid ULID regardless of case", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(true);
  });
});
