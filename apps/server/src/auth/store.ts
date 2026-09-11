import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  SessionRecordSchema,
  TokenRecordSchema,
  UserRecordSchema,
  buildOtpAuthUri,
  generateTotpSecret,
  hashPassword,
  normalizeLogin,
  verifyPassword,
  verifyTotpCode,
  type SessionRecord,
  type TokenRecord,
  type UserRecord,
  type UserRole,
  type UserStatus
} from "@ts-playwright/shared";
import { needsReseal, openSecret, sealSecret } from "../secrets";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// JSON-backed, atomically-written identity store (no native dependency). The repository shape
// keeps a future SQLite backend a localized swap. Users and sessions live OUTSIDE AppState so
// they never collide with project/run state.
export class AuthStore {
  private readonly usersFile: string;
  private readonly sessionsFile: string;
  private readonly tokensFile: string;

  constructor(
    private readonly dir: string,
    private readonly sessionTtlMs: number = DEFAULT_SESSION_TTL_MS
  ) {
    mkdirSync(dir, { recursive: true });
    this.usersFile = path.join(dir, "users.json");
    this.sessionsFile = path.join(dir, "sessions.json");
    this.tokensFile = path.join(dir, "tokens.json");
  }

  // ---- persistence helpers --------------------------------------------------
  private readUsers(): UserRecord[] {
    return readJsonArray(this.usersFile, (raw) => UserRecordSchema.parse(raw));
  }

  private writeUsers(users: UserRecord[]): void {
    writeJsonAtomic(this.usersFile, users);
  }

  private readSessions(): SessionRecord[] {
    return readJsonArray(this.sessionsFile, (raw) => SessionRecordSchema.parse(raw));
  }

  private writeSessions(sessions: SessionRecord[]): void {
    writeJsonAtomic(this.sessionsFile, sessions);
  }

  // ---- users ----------------------------------------------------------------
  listUsers(): UserRecord[] {
    return this.readUsers();
  }

  countUsers(): number {
    return this.readUsers().length;
  }

  findById(id: string): UserRecord | null {
    return this.readUsers().find((u) => u.id === id) ?? null;
  }

  findByLogin(login: string): UserRecord | null {
    const normalized = normalizeLogin(login);
    return this.readUsers().find((u) => u.login === normalized) ?? null;
  }

  // The first user to register becomes the admin (bootstrap); later users default to operator.
  createUser(input: { login: string; password: string; display_name?: string; role?: UserRole }): UserRecord {
    const login = normalizeLogin(input.login);
    if (!login) {
      throw new Error("Login is required");
    }
    if (!input.password || input.password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    const users = this.readUsers();
    if (users.some((u) => u.login === login)) {
      throw new Error("A user with this login already exists");
    }
    const now = new Date().toISOString();
    const role: UserRole = input.role ?? (users.length === 0 ? "admin" : "operator");
    const user: UserRecord = {
      id: `user_${randomUUID()}`,
      login,
      display_name: input.display_name?.trim() || login,
      password_hash: hashPassword(input.password),
      role,
      status: "active",
      created_at: now,
      updated_at: now,
      last_login_at: null,
      mfa_enabled: false,
      mfa_secret: null,
      pending_mfa_secret: null,
      mfa_recovery_hashes: []
    };
    users.push(user);
    this.writeUsers(users);
    return user;
  }

  setRole(id: string, role: UserRole): UserRecord | null {
    return this.mutateUser(id, (u) => {
      u.role = role;
    });
  }

  setStatus(id: string, status: UserStatus): UserRecord | null {
    const updated = this.mutateUser(id, (u) => {
      u.status = status;
    });
    if (updated && status === "disabled") {
      this.deleteUserSessions(id);
    }
    return updated;
  }

  setPassword(id: string, password: string): UserRecord | null {
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    return this.mutateUser(id, (u) => {
      u.password_hash = hashPassword(password);
    });
  }

  private mutateUser(id: string, mutate: (user: UserRecord) => void): UserRecord | null {
    const users = this.readUsers();
    const user = users.find((u) => u.id === id);
    if (!user) {
      return null;
    }
    mutate(user);
    user.updated_at = new Date().toISOString();
    this.writeUsers(users);
    return user;
  }

  // Returns the user only when active and the password matches. Does NOT record the login — call
  // recordLogin() once the full login (incl. any MFA step) succeeds.
  verifyCredentials(login: string, password: string): UserRecord | null {
    const user = this.findByLogin(login);
    if (!user || user.status !== "active") {
      return null;
    }
    if (!verifyPassword(password, user.password_hash)) {
      return null;
    }
    return user;
  }

  recordLogin(userId: string): void {
    this.mutateUser(userId, (u) => {
      u.last_login_at = new Date().toISOString();
    });
  }

  // ---- MFA (Phase 2 / 2-R6) -------------------------------------------------
  // Short-lived in-memory challenges issued after a correct password for an MFA-enabled user. The
  // session is only minted once the second factor is verified. In-memory is fine: a lost challenge
  // just means re-entering the password.
  private readonly mfaChallenges = new Map<string, { user_id: string; expires_at: number }>();
  private static readonly MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

  createMfaChallenge(userId: string): string {
    const token = randomBytes(24).toString("base64url");
    this.mfaChallenges.set(token, { user_id: userId, expires_at: Date.now() + AuthStore.MFA_CHALLENGE_TTL_MS });
    return token;
  }

  consumeMfaChallenge(token: string): UserRecord | null {
    const challenge = this.mfaChallenges.get(token);
    if (!challenge) {
      return null;
    }
    this.mfaChallenges.delete(token);
    if (challenge.expires_at < Date.now()) {
      return null;
    }
    const user = this.findById(challenge.user_id);
    return user && user.status === "active" ? user : null;
  }

  // Generate a fresh secret and stash it as pending until the user confirms a code from it. The
  // secret is sealed at rest (Phase 2 / 2-R8) via the same KEK as stand credentials; with no KEK it
  // passes through as plaintext (backward compatible).
  beginMfaEnrollment(userId: string, issuer = "ts-playwright"): { secret: string; otpauth_uri: string } | null {
    const user = this.findById(userId);
    if (!user) {
      return null;
    }
    const secret = generateTotpSecret();
    this.mutateUser(userId, (u) => {
      u.pending_mfa_secret = sealSecret(secret);
    });
    return { secret, otpauth_uri: buildOtpAuthUri(secret, { issuer, account: user.login }) };
  }

  // Confirm enrollment: the code must match the pending secret. On success MFA is enabled and a set
  // of one-time recovery codes is returned (only their hashes are stored).
  confirmMfaEnrollment(userId: string, code: string): { recovery_codes: string[] } | null {
    const user = this.findById(userId);
    const pending = openMfaSecret(user?.pending_mfa_secret ?? null);
    if (!user || !pending || !verifyTotpCode(pending, code)) {
      return null;
    }
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
    this.mutateUser(userId, (u) => {
      u.mfa_secret = sealSecret(pending);
      u.pending_mfa_secret = null;
      u.mfa_enabled = true;
      u.mfa_recovery_hashes = recoveryCodes.map((value) => sha256Hex(value));
    });
    return { recovery_codes: recoveryCodes };
  }

  // Re-seal every stored MFA secret under the current KEK (Phase 2 / 2-R8). Returns how many
  // secrets changed. open→seal is a no-op for values already sealed under the current key.
  resealMfaSecrets(): number {
    const users = this.readUsers();
    let changed = 0;
    for (const user of users) {
      for (const field of ["mfa_secret", "pending_mfa_secret"] as const) {
        const before = user[field];
        if (!needsReseal(before)) {
          continue;
        }
        user[field] = sealSecret(String(before));
        changed += 1;
      }
    }
    if (changed > 0) {
      this.writeUsers(users);
    }
    return changed;
  }

  disableMfa(userId: string): UserRecord | null {
    return this.mutateUser(userId, (u) => {
      u.mfa_enabled = false;
      u.mfa_secret = null;
      u.pending_mfa_secret = null;
      u.mfa_recovery_hashes = [];
    });
  }

  // Verify a TOTP code or consume a one-time recovery code for an MFA-enabled user.
  verifyMfaCode(userId: string, code: string): boolean {
    const user = this.findById(userId);
    if (!user || !user.mfa_enabled || !user.mfa_secret) {
      return false;
    }
    const secret = openMfaSecret(user.mfa_secret);
    if (secret && verifyTotpCode(secret, code)) {
      return true;
    }
    const hash = sha256Hex(String(code ?? "").replace(/\s+/g, "").toLowerCase());
    if (user.mfa_recovery_hashes.includes(hash)) {
      this.mutateUser(userId, (u) => {
        u.mfa_recovery_hashes = u.mfa_recovery_hashes.filter((value) => value !== hash);
      });
      return true;
    }
    return false;
  }

  // ---- sessions -------------------------------------------------------------
  createSession(userId: string): SessionRecord {
    const sessions = this.purgedSessions();
    const now = Date.now();
    const session: SessionRecord = {
      token: randomBytes(32).toString("base64url"),
      user_id: userId,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.sessionTtlMs).toISOString(),
      last_seen_at: new Date(now).toISOString()
    };
    sessions.push(session);
    this.writeSessions(sessions);
    return session;
  }

  // Resolve a session token to its (active) user, sliding last_seen_at. Null if invalid/expired.
  getValidSession(token: string): { session: SessionRecord; user: UserRecord } | null {
    if (!token) {
      return null;
    }
    const sessions = this.purgedSessions();
    const session = sessions.find((s) => s.token === token);
    if (!session) {
      this.writeSessions(sessions);
      return null;
    }
    const user = this.findById(session.user_id);
    if (!user || user.status !== "active") {
      return null;
    }
    session.last_seen_at = new Date().toISOString();
    this.writeSessions(sessions);
    return { session, user };
  }

  deleteSession(token: string): void {
    const sessions = this.readSessions().filter((s) => s.token !== token);
    this.writeSessions(sessions);
  }

  deleteUserSessions(userId: string): void {
    const sessions = this.readSessions().filter((s) => s.user_id !== userId);
    this.writeSessions(sessions);
  }

  private purgedSessions(): SessionRecord[] {
    const now = Date.now();
    return this.readSessions().filter((s) => Date.parse(s.expires_at) > now);
  }

  // ---- personal access tokens (agent auth) ----------------------------------
  private readTokens(): TokenRecord[] {
    return readJsonArray(this.tokensFile, (raw) => TokenRecordSchema.parse(raw));
  }

  private writeTokens(tokens: TokenRecord[]): void {
    writeJsonAtomic(this.tokensFile, tokens);
  }

  // Returns the plaintext token ONCE; only its hash is persisted.
  createToken(userId: string, label: string, scope = "agent"): { token: string; record: TokenRecord } {
    if (!this.findById(userId)) {
      throw new Error("User not found");
    }
    const plaintext = `tsp_${randomBytes(24).toString("base64url")}`;
    const record: TokenRecord = {
      id: `tok_${randomUUID()}`,
      user_id: userId,
      label: label?.trim() || "agent token",
      token_hash: sha256Hex(plaintext),
      scope,
      created_at: new Date().toISOString(),
      last_used_at: null
    };
    const tokens = this.readTokens();
    tokens.push(record);
    this.writeTokens(tokens);
    return { token: plaintext, record };
  }

  listTokens(userId: string): TokenRecord[] {
    return this.readTokens().filter((t) => t.user_id === userId);
  }

  deleteToken(userId: string, tokenId: string): boolean {
    const tokens = this.readTokens();
    const next = tokens.filter((t) => !(t.id === tokenId && t.user_id === userId));
    if (next.length === tokens.length) {
      return false;
    }
    this.writeTokens(next);
    return true;
  }

  // Resolve a bearer token to its active user, sliding last_used_at.
  verifyToken(plaintext: string): UserRecord | null {
    if (!plaintext) {
      return null;
    }
    const hash = sha256Hex(plaintext);
    const tokens = this.readTokens();
    const record = tokens.find((t) => t.token_hash === hash);
    if (!record) {
      return null;
    }
    const user = this.findById(record.user_id);
    if (!user || user.status !== "active") {
      return null;
    }
    record.last_used_at = new Date().toISOString();
    this.writeTokens(tokens);
    return user;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Open a sealed MFA secret. If the KEK is missing/wrong (e.g. lost after enabling MFA), return ""
// so verification fails cleanly (the "needs re-entry" case) instead of throwing and 500-ing login.
function openMfaSecret(stored: string | null): string {
  if (!stored) {
    return "";
  }
  try {
    return openSecret(stored);
  } catch {
    return "";
  }
}

function readJsonArray<T>(filePath: string, parseItem: (raw: unknown) => T): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: T[] = [];
    for (const item of parsed) {
      try {
        out.push(parseItem(item));
      } catch {
        // skip malformed records rather than crash the whole store
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
