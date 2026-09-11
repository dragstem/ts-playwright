import { describe, expect, it } from "vitest";
import {
  type Kek,
  decodeKeyMaterial,
  decryptSecret,
  encryptSecret,
  generateKekMaterialBase64,
  isEncrypted,
  loadKekFromEnv
} from "@ts-playwright/shared";

function makeKek(id = "v1"): Kek {
  return { id, key: decodeKeyMaterial(generateKekMaterialBase64()) };
}

describe("crypto envelope (Phase 2 / 2.2)", () => {
  it("round-trips a secret", () => {
    const kek = makeKek();
    const record = encryptSecret("super-secret-totp", kek);
    expect(isEncrypted(record)).toBe(true);
    expect(record).toMatch(/^enc:v1:v1:/);
    expect(record).not.toContain("super-secret-totp");
    expect(decryptSecret(record, () => kek)).toBe("super-secret-totp");
  });

  it("uses a fresh nonce per encryption (ciphertexts differ)", () => {
    const kek = makeKek();
    expect(encryptSecret("same", kek)).not.toBe(encryptSecret("same", kek));
  });

  it("fails to decrypt with the wrong key", () => {
    const a = makeKek();
    const b = makeKek();
    const record = encryptSecret("x", a);
    expect(() => decryptSecret(record, () => b)).toThrow();
  });

  it("detects tampering via the GCM auth tag", () => {
    const kek = makeKek();
    const record = encryptSecret("x", kek);
    const parts = record.split(":");
    const payload = Buffer.from(parts[4], "base64");
    payload[0] ^= 0xff;
    parts[4] = payload.toString("base64");
    expect(() => decryptSecret(parts.join(":"), () => kek)).toThrow();
  });

  it("resolves the KEK by key_id (supports rotation)", () => {
    const v1 = makeKek("v1");
    const v2 = makeKek("v2");
    const recordV1 = encryptSecret("old", v1);
    const recordV2 = encryptSecret("new", v2);
    const resolve = (id: string) => (id === "v1" ? v1 : id === "v2" ? v2 : null);
    expect(decryptSecret(recordV1, resolve)).toBe("old");
    expect(decryptSecret(recordV2, resolve)).toBe("new");
  });

  it("throws when no KEK is available for the key_id", () => {
    const kek = makeKek("v9");
    const record = encryptSecret("x", kek);
    expect(() => decryptSecret(record, () => null)).toThrow(/key_id=v9/);
  });

  it("decodeKeyMaterial accepts base64 and 64-char hex, rejects bad length", () => {
    expect(decodeKeyMaterial("00".repeat(32)).length).toBe(32);
    expect(decodeKeyMaterial(generateKekMaterialBase64()).length).toBe(32);
    expect(() => decodeKeyMaterial("too-short")).toThrow();
  });

  it("loadKekFromEnv reads inline env material or returns null", () => {
    expect(loadKekFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    const material = generateKekMaterialBase64();
    const kek = loadKekFromEnv({ APP_KEK: material, APP_KEK_ID: "v3" } as unknown as NodeJS.ProcessEnv);
    expect(kek?.id).toBe("v3");
    expect(kek?.key.length).toBe(32);
  });
});
