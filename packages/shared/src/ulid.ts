import { randomBytes } from "node:crypto";

// Minimal ULID (Universally Unique Lexicographically Sortable Identifier) — 26-char Crockford
// base32: 48-bit timestamp + 80-bit randomness. No dependency. Sortable by creation time, which is
// why it is preferred over a random UUID for scenario ids (Phase 2 / 2-R4).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function generateUlid(time = Date.now()): string {
  let timestamp = Math.floor(time);
  const timeChars: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    timeChars.unshift(CROCKFORD[timestamp % 32]);
    timestamp = Math.floor(timestamp / 32);
  }
  return timeChars.join("") + encodeRandom(randomBytes(10), 16);
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value.toUpperCase());
}

function encodeRandom(bytes: Buffer, chars: number): string {
  let bits = "";
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let out = "";
  for (let index = 0; index < chars; index += 1) {
    out += CROCKFORD[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)];
  }
  return out;
}
