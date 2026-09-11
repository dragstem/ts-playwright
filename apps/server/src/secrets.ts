import { decryptSecret, encryptSecret, isEncrypted, loadKekFromEnv, type Kek } from "@ts-playwright/shared";

// Phase 2 / 2.2 — encryption-at-rest for stand-credential secrets (account password + TOTP).
// Opt-in: only active when a KEK is configured via env (APP_KEK / APP_KEK_FILE). With no KEK
// everything passes through as plaintext, so existing setups and tests are unchanged.
// The KEK is read from the environment on each call (cheap; keeps tests that toggle it simple).

function currentKek(): Kek | null {
  return loadKekFromEnv();
}

export function secretsEncryptionEnabled(): boolean {
  return currentKek() !== null;
}

// Encrypt a value for storage when a KEK is configured; otherwise return it unchanged.
// Already-encrypted values are returned as-is (idempotent).
export function sealSecret(plaintext: string | null | undefined): string {
  const value = String(plaintext ?? "");
  if (!value || isEncrypted(value)) {
    return value;
  }
  const kek = currentKek();
  return kek ? encryptSecret(value, kek) : value;
}

// True when a value should be (re)sealed: it is non-empty plaintext while a KEK is configured.
// Already-encrypted records are left alone — AES-GCM re-encryption would change the ciphertext on
// every call (fresh nonce), so gating on this keeps reseal idempotent. Cross-key rotation (opening
// under an old key, re-sealing under a new one) is a separate operator procedure needing both keys.
export function needsReseal(stored: string | null | undefined): boolean {
  const value = String(stored ?? "");
  if (!value || !secretsEncryptionEnabled()) {
    return false;
  }
  return !isEncrypted(value);
}

// Decrypt a stored value if it is an enc record; plaintext (legacy) is returned unchanged.
export function openSecret(stored: string | null | undefined): string {
  const value = String(stored ?? "");
  if (!isEncrypted(value)) {
    return value;
  }
  const kek = currentKek();
  if (!kek) {
    throw new Error("Secret is encrypted but no APP_KEK is configured to decrypt it");
  }
  return decryptSecret(value, (keyId) => (kek.id === keyId ? kek : null));
}
