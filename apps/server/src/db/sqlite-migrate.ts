import { DatabaseSync } from "node:sqlite";
import { AppStateSchema, type AppState } from "@ts-playwright/shared";

// Phase 2 / 2-R1 + 2-R2 — SQLite backend foundation + JSON→SQLite migration. Uses Node's built-in
// node:sqlite (no native dependency). Each AppState collection becomes its own table with the
// primary key column(s) plus a JSON `data` column holding the full record — a lossless,
// per-entity (repository-style) layout that round-trips through the existing Zod schemas.

interface TableSpec {
  table: string;
  // The state key holding the array of records.
  key: keyof AppState;
  // Columns (besides `data`) materialized for indexing/uniqueness; derived from each record.
  columns: { name: string; of: (record: Record<string, unknown>) => unknown }[];
}

const TABLES: TableSpec[] = [
  { table: "projects", key: "projects", columns: [{ name: "id", of: (r) => r.id }] },
  { table: "environments", key: "environments", columns: [{ name: "id", of: (r) => r.id }] },
  {
    table: "accounts",
    key: "accounts",
    columns: [
      { name: "login", of: (r) => r.login },
      { name: "project_id", of: (r) => r.project_id ?? null }
    ]
  },
  {
    table: "merchants",
    key: "merchants",
    columns: [
      { name: "name", of: (r) => r.name },
      { name: "project_id", of: (r) => r.project_id ?? null }
    ]
  },
  { table: "project_server_vars", key: "project_server_vars", columns: [{ name: "project_id", of: (r) => r.project_id }] },
  { table: "pools", key: "pools", columns: [{ name: "id", of: (r) => r.id }] },
  { table: "pool_items", key: "pool_items", columns: [{ name: "id", of: (r) => r.id }] },
  { table: "scenarios", key: "scenarios", columns: [{ name: "id", of: (r) => r.id }] },
  { table: "runs", key: "runs", columns: [{ name: "id", of: (r) => r.id }] }
];

export interface MigrationReport {
  dry_run: boolean;
  tables: { table: string; rows: number }[];
  total_rows: number;
}

function records(state: AppState, key: keyof AppState): Record<string, unknown>[] {
  const value = state[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function createSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  for (const spec of TABLES) {
    const cols = spec.columns.map((column) => `${column.name} TEXT`).join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS ${spec.table} (${cols}, data TEXT NOT NULL);`);
  }
}

// Export an AppState into a SQLite database (transactional). With dryRun, nothing is written — the
// report still reflects exactly what would be inserted.
export function migrateStateToSqlite(state: AppState, dbPath: string, options: { dryRun?: boolean } = {}): MigrationReport {
  const normalized = AppStateSchema.parse(state);
  const report: MigrationReport = {
    dry_run: Boolean(options.dryRun),
    tables: TABLES.map((spec) => ({ table: spec.table, rows: records(normalized, spec.key).length })),
    total_rows: 0
  };
  report.total_rows = report.tables.reduce((sum, entry) => sum + entry.rows, 0);
  if (options.dryRun) {
    return report;
  }

  const db = new DatabaseSync(dbPath);
  try {
    createSchema(db);
    db.exec("BEGIN");
    try {
      for (const spec of TABLES) {
        db.exec(`DELETE FROM ${spec.table};`);
        const columnNames = [...spec.columns.map((column) => column.name), "data"];
        const placeholders = columnNames.map(() => "?").join(", ");
        const statement = db.prepare(`INSERT INTO ${spec.table} (${columnNames.join(", ")}) VALUES (${placeholders});`);
        for (const record of records(normalized, spec.key)) {
          const values = spec.columns.map((column) => toSqlValue(column.of(record)));
          statement.run(...values, JSON.stringify(record));
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return report;
}

// Reconstruct an AppState from a migrated SQLite database.
export function readStateFromSqlite(dbPath: string): AppState {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const assembled: Record<string, unknown[]> = {};
    for (const spec of TABLES) {
      const rows = db.prepare(`SELECT data FROM ${spec.table};`).all();
      assembled[spec.key] = rows.map((row) => JSON.parse(String(row.data)));
    }
    return AppStateSchema.parse(assembled);
  } finally {
    db.close();
  }
}

// True when the SQLite database round-trips to the same normalized state (used as the migration's
// post-step verification).
export function verifySqliteMatchesState(state: AppState, dbPath: string): boolean {
  const expected = JSON.stringify(AppStateSchema.parse(state));
  const actual = JSON.stringify(readStateFromSqlite(dbPath));
  return expected === actual;
}

function toSqlValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return String(value);
}
