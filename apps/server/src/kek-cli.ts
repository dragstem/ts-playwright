import { generateKekMaterialBase64 } from "@ts-playwright/shared";

// Phase 2 / 2-R8 — generate a fresh 32-byte KEK (base64) for AES-256-GCM secret encryption.
//   pnpm kek:generate
// Print the key on stdout (so it can be piped to a file) and guidance on stderr.
const key = generateKekMaterialBase64();
process.stdout.write(`${key}\n`);
process.stderr.write(
  [
    "Generated a 32-byte KEK (base64).",
    "Set it as APP_KEK, or write it to a file referenced by APP_KEK_FILE.",
    "Back it up SEPARATELY from the database — losing it makes encrypted secrets unrecoverable.",
    "After enabling it on existing data, run `pnpm secrets:reseal` to encrypt current plaintext secrets."
  ].join("\n") + "\n"
);
