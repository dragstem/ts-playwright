import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../apps/server/src/db/sqlite-store";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-sqlitestore-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteStateStore (2-R1)", () => {
  it("seeds the demo project/environment on first init", () => {
    const store = new SqliteStateStore(dir);
    const state = store.readState();
    expect(existsSync(path.join(dir, "state.db"))).toBe(true);
    expect(state.projects.map((p) => p.id)).toContain("proj_demo");
    expect(state.environments.find((e) => e.id === "staging")?.is_default).toBe(true);
  });

  it("persists mutations across a fresh store instance", () => {
    const store = new SqliteStateStore(dir);
    store.update((state) => {
      state.accounts.push({
        login: "alice",
        password: "pw",
        "2fa_otp": "",
        project_id: "proj_demo",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      });
    });

    // A brand-new instance over the same dir reads the committed row back.
    const reopened = new SqliteStateStore(dir);
    const account = reopened.readState().accounts.find((a) => a.login === "alice");
    expect(account?.project_id).toBe("proj_demo");
  });

  it("applies newly-configured seed entities without duplicating existing ones", () => {
    new SqliteStateStore(dir); // first init, no seeds
    const seeded = new SqliteStateStore(dir, {
      accounts: [{ login: "seed-user", password: "pw", "2fa_otp": "" }]
    });
    expect(seeded.readState().accounts.filter((a) => a.login === "seed-user")).toHaveLength(1);

    // Re-opening with the same seed does not add a duplicate.
    const again = new SqliteStateStore(dir, {
      accounts: [{ login: "seed-user", password: "pw", "2fa_otp": "" }]
    });
    expect(again.readState().accounts.filter((a) => a.login === "seed-user")).toHaveLength(1);
  });

  it("returns the update callback's value", () => {
    const store = new SqliteStateStore(dir);
    const count = store.update((state) => state.projects.length);
    expect(count).toBeGreaterThan(0);
  });
});
