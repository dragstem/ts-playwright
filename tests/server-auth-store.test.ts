import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../apps/server/src/auth/store";

let dir: string;
let store: AuthStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tsp-auth-"));
  store = new AuthStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AuthStore (Phase 2 / 2.3)", () => {
  it("makes the first user an admin and later users operators", () => {
    const admin = store.createUser({ login: "Admin@example.com ", password: "supersecret1" });
    expect(admin.role).toBe("admin");
    expect(admin.login).toBe("admin@example.com"); // normalized
    expect((admin as { password_hash: string }).password_hash).not.toContain("supersecret1");

    const op = store.createUser({ login: "op@example.com", password: "anothersecret" });
    expect(op.role).toBe("operator");
    expect(store.countUsers()).toBe(2);
  });

  it("rejects duplicate logins and short passwords", () => {
    store.createUser({ login: "a@b.com", password: "longenough1" });
    expect(() => store.createUser({ login: "A@B.com", password: "longenough2" })).toThrow(/already exists/);
    expect(() => store.createUser({ login: "c@b.com", password: "short" })).toThrow(/at least 8/);
  });

  it("verifies credentials only for active users with the right password", () => {
    const u = store.createUser({ login: "user@x.com", password: "correctpass1" });
    expect(store.verifyCredentials("user@x.com", "wrong")).toBeNull();
    const ok = store.verifyCredentials("USER@x.com", "correctpass1");
    expect(ok?.id).toBe(u.id);
    // verifyCredentials no longer records the login (an MFA step may still follow); recordLogin does.
    expect(ok?.last_login_at).toBeNull();
    store.recordLogin(u.id);
    expect(store.findById(u.id)?.last_login_at).not.toBeNull();

    store.setStatus(u.id, "disabled");
    expect(store.verifyCredentials("user@x.com", "correctpass1")).toBeNull();
  });

  it("creates and resolves sessions, and rejects unknown tokens", () => {
    const u = store.createUser({ login: "s@x.com", password: "sessionpass1" });
    const session = store.createSession(u.id);
    const resolved = store.getValidSession(session.token);
    expect(resolved?.user.id).toBe(u.id);
    expect(store.getValidSession("nope")).toBeNull();

    store.deleteSession(session.token);
    expect(store.getValidSession(session.token)).toBeNull();
  });

  it("expires sessions past their TTL", () => {
    const shortStore = new AuthStore(dir, -1); // already-expired TTL
    const u = shortStore.createUser({ login: "e@x.com", password: "expirepass1" });
    const session = shortStore.createSession(u.id);
    expect(shortStore.getValidSession(session.token)).toBeNull();
  });

  it("changing role and password persists; disabling drops sessions", () => {
    const admin = store.createUser({ login: "admin@x.com", password: "adminpass11" });
    const u = store.createUser({ login: "u2@x.com", password: "userpass111" });
    const session = store.createSession(u.id);

    expect(store.setRole(u.id, "viewer")?.role).toBe("viewer");
    expect(store.setPassword(u.id, "newpassword1")?.id).toBe(u.id);
    expect(store.verifyCredentials("u2@x.com", "newpassword1")?.id).toBe(u.id);

    store.setStatus(u.id, "disabled");
    expect(store.getValidSession(session.token)).toBeNull();
    expect(store.findById(admin.id)?.role).toBe("admin");
  });
});
