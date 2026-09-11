import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Phase 2 / 2.7 — append-only audit log of security-relevant actions (logins, user/role changes,
// credential edits). JSON-backed with atomic writes and a rolling cap; no native dependency.

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actor_id: string | null;
  actor_login: string | null;
  target: string | null;
  meta: Record<string, unknown>;
}

const DEFAULT_MAX_ENTRIES = 5000;

export class AuditStore {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly max = DEFAULT_MAX_ENTRIES
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "audit-log.json");
  }

  record(input: {
    action: string;
    actor_id?: string | null;
    actor_login?: string | null;
    target?: string | null;
    meta?: Record<string, unknown>;
  }): AuditEntry {
    const entry: AuditEntry = {
      id: `audit_${randomBytes(8).toString("hex")}`,
      at: new Date().toISOString(),
      action: input.action,
      actor_id: input.actor_id ?? null,
      actor_login: input.actor_login ?? null,
      target: input.target ?? null,
      meta: input.meta ?? {}
    };
    const entries = this.read();
    entries.push(entry);
    const capped = entries.length > this.max ? entries.slice(entries.length - this.max) : entries;
    this.write(capped);
    return entry;
  }

  // Newest first, optionally filtered by action and limited.
  list(opts: { limit?: number; action?: string } = {}): AuditEntry[] {
    let entries = this.read().reverse();
    if (opts.action) {
      entries = entries.filter((e) => e.action === opts.action);
    }
    if (opts.limit && opts.limit > 0) {
      entries = entries.slice(0, opts.limit);
    }
    return entries;
  }

  private read(): AuditEntry[] {
    if (!existsSync(this.file)) {
      return [];
    }
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
    } catch {
      return [];
    }
  }

  private write(entries: AuditEntry[]): void {
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
