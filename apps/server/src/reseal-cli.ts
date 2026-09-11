import { loadConfig } from "./config";
import { JsonStateStore } from "./store";
import { AuthStore } from "./auth/store";
import { resealAppStateSecrets } from "./reseal";
import { secretsEncryptionEnabled } from "./secrets";

// CLI: re-seal all stored secrets under the currently-configured KEK (Phase 2 / 2-R8).
//   pnpm secrets:reseal
// Run after enabling APP_KEK on existing plaintext data, or after a key rotation.
function main(): void {
  if (!secretsEncryptionEnabled()) {
    process.stderr.write("No APP_KEK is configured — nothing to seal. Set APP_KEK (see `pnpm kek:generate`).\n");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const store = new JsonStateStore(config.state_file, {
    accounts: config.seed_accounts,
    merchants: config.seed_merchants,
    pools: config.seed_pools,
    pool_items: config.seed_pool_items
  });
  const report = store.update((state) => resealAppStateSecrets(state).report);
  const mfaResealed = new AuthStore(config.storage_dir).resealMfaSecrets();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...report, mfa_secrets: mfaResealed }, null, 2));
}

main();
