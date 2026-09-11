import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AppStateSchema, type AppState } from "@ts-playwright/shared";
import {
  JsonStateStore,
  applySeedEntities,
  createSeedState,
  hydrateStateFromStorage,
  type SeedStateEntities,
  type StateStore
} from "../store";
import { migrateStateToSqlite, readStateFromSqlite } from "./sqlite-migrate";

// Phase 2 / 2-R1 — opt-in SQLite-backed state store (APP_STATE_BACKEND=sqlite). Persists the core
// AppState in SQLite (transactional, WAL) while scenario packages stay on disk and are hydrated the
// same way as the JSON store — so switching backends is transparent to the rest of the server.
// Selected by config; JSON remains the default. Reversible: the JSON files are untouched.
export class SqliteStateStore implements StateStore {
  private readonly dbPath: string;

  constructor(
    private readonly storageDir: string,
    seedEntities: SeedStateEntities = {},
    dbFileName = "state.db"
  ) {
    mkdirSync(storageDir, { recursive: true });
    this.dbPath = path.join(storageDir, dbFileName);
    if (!existsSync(this.dbPath)) {
      // First boot on the SQLite backend: if a JSON state file already exists, import it (2-R2
      // cutover — switching APP_STATE_BACKEND to sqlite migrates the current data automatically).
      // Otherwise seed a fresh state. The JSON files are left untouched, so the switch is reversible.
      const jsonStateFile = path.join(storageDir, "app-state.json");
      const initial = existsSync(jsonStateFile)
        ? new JsonStateStore(jsonStateFile, seedEntities).readState()
        : createSeedState(seedEntities);
      migrateStateToSqlite(initial, this.dbPath);
    } else {
      // Apply any newly-configured seed entities (idempotent — existing keys are skipped).
      const seeded = applySeedEntities(readStateFromSqlite(this.dbPath), seedEntities);
      migrateStateToSqlite(seeded, this.dbPath);
    }
  }

  readState(): AppState {
    const core = readStateFromSqlite(this.dbPath);
    return AppStateSchema.parse(hydrateStateFromStorage(this.storageDir, core));
  }

  writeState(state: AppState): void {
    migrateStateToSqlite(AppStateSchema.parse(state), this.dbPath);
  }

  update<T>(mutate: (state: AppState) => T): T {
    const state = this.readState();
    const result = mutate(state);
    this.writeState(state);
    return result;
  }
}
