import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Phase 2 / 2.3 — password hashing for tool users. Uses scrypt from node:crypto (no native
// dependency, unlike argon2). Stored format:  scrypt:<N>:<r>:<p>:<salt_b64>:<hash_b64>
// Parameters are stored in the record so they can be tuned later without breaking old hashes.

const SCHEME = "scrypt";
const DEFAULT_N = 16384; // CPU/memory cost
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;

export function hashPassword(plain: string): string {
  if (!plain) {
    throw new Error("Password must not be empty");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_LEN, { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P });
  return [SCHEME, DEFAULT_N, DEFAULT_R, DEFAULT_P, salt.toString("base64"), hash.toString("base64")].join(":");
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 6 || parts[0] !== SCHEME) {
    return false;
  }
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 1) {
    return false;
  }
  const expected = Buffer.from(hashB64, "base64");
  const salt = Buffer.from(saltB64, "base64");
  if (expected.length === 0 || salt.length === 0) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isPasswordHash(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${SCHEME}:`);
}
