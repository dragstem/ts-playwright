import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AppStateSchema,
  DEFAULT_OTP_ACCOUNTS,
  type AppState,
  type EnvironmentRecord,
  type OtpAccountRecord,
  type ProjectRecord
} from "@ts-playwright/shared";

export class JsonStateStore {
  constructor(private readonly stateFile: string) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    if (!existsSync(stateFile)) {
      this.writeState(createSeedState());
    } else {
      const parsed = this.readState();
      this.writeState(parsed);
    }
  }

  readState(): AppState {
    const raw = readFileSync(this.stateFile, "utf8");
    return AppStateSchema.parse(JSON.parse(raw));
  }

  writeState(state: AppState): void {
    writeFileSync(this.stateFile, JSON.stringify(AppStateSchema.parse(state), null, 2), "utf8");
  }

  update<T>(mutate: (state: AppState) => T): T {
    const state = this.readState();
    const result = mutate(state);
    this.writeState(state);
    return result;
  }
}

function createSeedState(): AppState {
  const now = new Date().toISOString();
  const projects: ProjectRecord[] = [
    {
      id: "proj_demo",
      name: "Demo Project",
      description: "Sample project"
    }
  ];
  const environments: EnvironmentRecord[] = [
    {
      id: "staging",
      project_id: "proj_demo",
      name: "staging",
      base_url: "https://google.com",
      is_default: true
    }
  ];
  const otpAccounts: OtpAccountRecord[] = DEFAULT_OTP_ACCOUNTS.map((item) => ({
    login: item.login,
    secret: item.secret,
    created_at: now,
    updated_at: now
  }));

  return AppStateSchema.parse({
    projects,
    environments,
    otp_accounts: otpAccounts,
    scenarios: [],
    runs: []
  });
}
