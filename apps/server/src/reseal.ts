import type { AppState } from "@ts-playwright/shared";
import { needsReseal, sealSecret, secretsEncryptionEnabled } from "./secrets";

// Phase 2 / 2-R8 (KEK lifecycle) — re-seal every stored secret under the currently-configured KEK.
// Used when first enabling encryption (plaintext → enc records) and after a key rotation (records
// are opened with the resolvable KEK, then re-sealed under the current key_id). open→seal is a no-op
// for values already sealed under the current key, so running it repeatedly is safe.
export interface ResealReport {
  encryption_enabled: boolean;
  account_secrets: number;
  project_var_secrets: number;
  total: number;
}

function reseal(value: string | null | undefined): { value: string; changed: boolean } {
  const before = String(value ?? "");
  if (!needsReseal(before)) {
    return { value: before, changed: false };
  }
  return { value: sealSecret(before), changed: true };
}

export function resealAppStateSecrets(state: AppState): { state: AppState; report: ResealReport } {
  const report: ResealReport = {
    encryption_enabled: secretsEncryptionEnabled(),
    account_secrets: 0,
    project_var_secrets: 0,
    total: 0
  };

  for (const account of state.accounts) {
    const password = reseal(account.password);
    account.password = password.value;
    if (password.changed) {
      report.account_secrets += 1;
    }
    const otp = reseal(account["2fa_otp"]);
    account["2fa_otp"] = otp.value;
    if (otp.changed) {
      report.account_secrets += 1;
    }
  }

  for (const vars of state.project_server_vars) {
    const password = reseal(vars.server_password);
    vars.server_password = password.value;
    if (password.changed) {
      report.project_var_secrets += 1;
    }
    const otp = reseal(vars.server_2faotp);
    vars.server_2faotp = otp.value;
    if (otp.changed) {
      report.project_var_secrets += 1;
    }
  }

  report.total = report.account_secrets + report.project_var_secrets;
  return { state, report };
}
