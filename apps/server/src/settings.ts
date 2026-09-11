import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Runtime-adjustable settings (max concurrent runner containers). Persisted to a small JSON file so
// a UI change survives restarts; separate from AppState so it works under either state backend.
export interface RuntimeSettings {
  max_concurrent_runs: number;
}

function clampConcurrency(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export class SettingsStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly defaults: RuntimeSettings
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "runtime-settings.json");
  }

  read(): RuntimeSettings {
    if (!existsSync(this.file)) {
      return { ...this.defaults };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { max_concurrent_runs?: unknown };
      return { max_concurrent_runs: clampConcurrency(parsed.max_concurrent_runs, this.defaults.max_concurrent_runs) };
    } catch {
      return { ...this.defaults };
    }
  }

  write(settings: { max_concurrent_runs?: unknown }): RuntimeSettings {
    const next: RuntimeSettings = {
      max_concurrent_runs: clampConcurrency(settings.max_concurrent_runs, this.defaults.max_concurrent_runs)
    };
    writeFileSync(this.file, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}
