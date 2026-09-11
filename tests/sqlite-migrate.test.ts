import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStateSchema } from "@ts-playwright/shared";
import {
  migrateStateToSqlite,
  readStateFromSqlite,
  verifySqliteMatchesState
} from "../apps/server/src/db/sqlite-migrate";

let dir = "";

const sampleState = AppStateSchema.parse({
  projects: [{ id: "proj_demo", name: "Demo" }],
  environments: [{ id: "staging", project_id: "proj_demo", name: "staging", base_url: "https://example.com", is_default: true }],
  accounts: [
    { login: "alice", password: "p1", "2fa_otp": "", project_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    { login: "alice", password: "p2", "2fa_otp": "", project_id: "proj_demo", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }
  ],
  merchants: [{ name: "acme", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
  scenarios: [
    {
      id: "scn-a",
      project_id: "proj_demo",
      env_id: "staging",
      name: "A",
      slug: "a",
      folder_path: "suite/a",
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      package_path: "suite/a/package.zip",
      status: "active",
      inputs: [{ name: "x", type: "string", description: "", otp_login: "" }]
    }
  ],
  runs: [
    {
      id: "run-1",
      scenario_id: "scn-a",
      triggered_by: "api",
      triggered_at: "2026-02-01T00:00:00.000Z",
      status: "passed",
      outcome: "passed",
      inputs: { x: "1" }
    }
  ]
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-sqlite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("JSON → SQLite migration (2-R1 / 2-R2)", () => {
  it("migrates state and round-trips it back losslessly", () => {
    const dbPath = path.join(dir, "state.db");
    const report = migrateStateToSqlite(sampleState, dbPath);
    expect(report.dry_run).toBe(false);
    expect(report.total_rows).toBe(7); // 1 project + 1 env + 2 accounts + 1 merchant + 1 scenario + 1 run
    expect(report.tables.find((t) => t.table === "accounts")?.rows).toBe(2);

    const back = readStateFromSqlite(dbPath);
    expect(JSON.stringify(back)).toBe(JSON.stringify(sampleState));
    expect(verifySqliteMatchesState(sampleState, dbPath)).toBe(true);
  });

  it("dry-run reports counts without writing the database", () => {
    const dbPath = path.join(dir, "dry.db");
    const report = migrateStateToSqlite(sampleState, dbPath, { dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.total_rows).toBe(7);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("re-migrating replaces rows rather than duplicating them", () => {
    const dbPath = path.join(dir, "state.db");
    migrateStateToSqlite(sampleState, dbPath);
    migrateStateToSqlite(sampleState, dbPath);
    const back = readStateFromSqlite(dbPath);
    expect(back.accounts).toHaveLength(2);
    expect(back.runs).toHaveLength(1);
  });
});
