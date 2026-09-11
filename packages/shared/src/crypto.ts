import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Phase 2 / 2.2 — envelope encryption for secrets at rest (stand passwords, TOTP secrets).
// Record format:  enc:v1:<key_id>:<nonce_b64>:<ciphertext+tag_b64>
// - AES-256-GCM with an independent 12-byte nonce per record.
// - key_id identifies the KEK version so old and new records can coexist during rotation.
// Uses only node:crypto — no native dependencies.

const PREFIX = "enc";
const VERSION = "v1";
const NONCE_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length
const KEY_BYTES = 32; // AES-256

export interface Kek {
  /** key_id stored in the record, e.g. "v1". */
  id: string;
  /** 32 bytes of key material. */
  key: Buffer;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:${VERSION}:`);
}

export function encryptSecret(plaintext: string, kek: Kek): string {
  if (kek.key.length !== KEY_BYTES) {
    throw new Error("KEK must be 32 bytes for AES-256-GCM");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek.key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([ciphertext, tag]);
  return [PREFIX, VERSION, kek.id, nonce.toString("base64"), payload.toString("base64")].join(":");
}

export function decryptSecret(record: string, resolveKek: (keyId: string) => Kek | null): string {
  const parts = record.split(":");
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== VERSION) {
    throw new Error("Not a valid enc:v1 record");
  }
  const [, , keyId, nonceB64, payloadB64] = parts;
  const kek = resolveKek(keyId);
  if (!kek) {
    throw new Error(`No KEK available for key_id=${keyId}`);
  }
  if (kek.key.length !== KEY_BYTES) {
    throw new Error("KEK must be 32 bytes for AES-256-GCM");
  }
  const nonce = Buffer.from(nonceB64, "base64");
  const payload = Buffer.from(payloadB64, "base64");
  if (payload.length <= TAG_BYTES) {
    throw new Error("Ciphertext too short");
  }
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek.key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// Accept base64 (preferred) or 64-char hex key material; must decode to exactly 32 bytes.
export function decodeKeyMaterial(raw: string): Buffer {
  const trimmed = String(raw ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES) {
    return decoded;
  }
  throw new Error("KEK material must decode to 32 bytes (base64 or 64-char hex)");
}

export function generateKekMaterialBase64(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

// Load the KEK from the environment. Precedence: explicit file, then inline env var.
// (A KMS provider is intended for production and plugs in here later.) Returns null if none set.
export function loadKekFromEnv(env: NodeJS.ProcessEnv = process.env): Kek | null {
  const provider = String(env.APP_KEK_PROVIDER ?? "").trim().toLowerCase();
  const keyId = String(env.APP_KEK_ID ?? "v1").trim() || "v1";
  let raw: string | null = null;

  const file = String(env.APP_KEK_FILE ?? "").trim();
  if ((provider === "file" || (!provider && file)) && file && existsSync(file)) {
    raw = readFileSync(file, "utf8").trim();
  }
  if (!raw && (provider === "env" || !provider)) {
    raw = String(env.APP_KEK ?? "").trim() || null;
  }
  if (!raw) {
    return null;
  }
  return { id: keyId, key: decodeKeyMaterial(raw) };
}
