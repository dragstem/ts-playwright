import path from "node:path";
import { loadConfig } from "../config";
import { JsonStateStore } from "../store";
import { migrateStateToSqlite, verifySqliteMatchesState } from "./sqlite-migrate";

// CLI: export the current JSON-backed AppState into a SQLite database (2-R1 / 2-R2).
//   tsx apps/server/src/db/migrate-cli.ts [out.db] [--dry-run]
// Defaults the output to <storage>/state.db. A dry run prints the row plan without writing.
function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outArg = args.find((arg) => !arg.startsWith("--"));
  const config = loadConfig();
  const store = new JsonStateStore(config.state_file);
  const state = store.readState();
  const dbPath = outArg ? path.resolve(outArg) : path.join(config.storage_dir, "state.db");

  const report = migrateStateToSqlite(state, dbPath, { dryRun });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ db: dryRun ? null : dbPath, ...report }, null, 2));
  if (!dryRun) {
    const ok = verifySqliteMatchesState(state, dbPath);
    // eslint-disable-next-line no-console
    console.log(ok ? "verify: OK (round-trips losslessly)" : "verify: FAILED");
    if (!ok) {
      process.exitCode = 1;
    }
  }
}

main();
