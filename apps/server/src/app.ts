import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import AdmZip from "adm-zip";
import {
  AccountOtpCodeCreateBodySchema,
  AccountUpsertBodySchema,
  EnvironmentUpsertBodySchema,
  FolderCreateBodySchema,
  FolderRunCreateBodySchema,
  FolderMoveBodySchema,
  MerchantUpsertBodySchema,
  PoolImportRunOutputsBodySchema,
  PoolItemBulkBodySchema,
  PoolItemUpsertBodySchema,
  PoolUpsertBodySchema,
  ProjectUpsertBodySchema,
  RunCreateBodySchema,
  RunOutputAddToPoolBodySchema,
  ScenarioMetadataSchema,
  ScenarioMoveBodySchema,
  SCENARIO_FILE_NAME,
  generateUlid,
  isUlid,
  type AccountRecord,
  type AppState,
  type EnvironmentRecord,
  type MerchantRecord,
  type PoolItemRecord,
  type PoolRecord,
  type PoolSelection,
  type ProjectRecord,
  type ProjectServerVarsRecord,
  type RunLogEntry,
  type RunLogLevel,
  type RunOutcome,
  type RunPhase,
  type RunStatus,
  type RunRecord,
  type ScenarioRecord,
  folderDir,
  isScenarioDir,
  normalizeFolderPath,
  normalizeInputSpecs,
  normalizeOtpLogin,
  generateTotpCodeSafeDetails,
  normalizeTotpSecret,
  projectRootDir,
  runArtifactsDir,
  safeJoin,
  scenarioDirFromPackage,
  scenarioPackagePath,
  slugify,
  uniqueChildDir
} from "@ts-playwright/shared";
import {
  detectRequiredServerInputs,
  runScenarioInDocker,
  type RunExecutionLogEvent
} from "@ts-playwright/runner";
import { loadConfig } from "./config";
import { prepareFolderRunPlans, prepareScenarioRunPlan, previewServerBindings, type PreparedRunPlan } from "./run-planner";
import { summarizeBatch, summarizeBatches } from "./batches";
import { JsonStateStore, type StateStore } from "./store";
import { SqliteStateStore } from "./db/sqlite-store";
import { Semaphore } from "./lib/semaphore";
import { SettingsStore } from "./settings";
import { AuthStore } from "./auth/store";
import { AuditStore } from "./auth/audit";
import { openSecret, sealSecret } from "./secrets";
import {
  LoginBodySchema,
  MfaCodeBodySchema,
  MfaLoginBodySchema,
  RegisterBodySchema,
  UserRoleSchema,
  UserStatusSchema,
  toPublicToken,
  toPublicUser,
  type UserRecord,
  type UserRole
} from "@ts-playwright/shared";

const config = loadConfig();
const seedEntities = {
  accounts: config.seed_accounts,
  merchants: config.seed_merchants,
  pools: config.seed_pools,
  pool_items: config.seed_pool_items
};
// Phase 2 / 2-R1 — pick the state backend. JSON is the default; APP_STATE_BACKEND=sqlite opts into
// the SQLite store (node:sqlite, transactional). Both hydrate scenarios from disk, so the rest of
// the server is backend-agnostic.
const store: StateStore =
  config.state_backend === "sqlite"
    ? new SqliteStateStore(config.storage_dir, seedEntities)
    : new JsonStateStore(config.state_file, seedEntities);
const authStore = new AuthStore(config.storage_dir);
const auditStore = new AuditStore(config.storage_dir);
const SESSION_COOKIE = "ts_session";

// Phase 3 (3.M3) — in-process pub/sub for live run updates (SSE). A single emitter fans run
// events out to connected /api/runs/:id/stream subscribers; no external broker.
const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);
interface RunEvent {
  run_id: string;
  type: "run.log" | "run.phase" | "run.status";
  payload: unknown;
}
function emitRunEvent(runId: string, type: RunEvent["type"], payload: unknown): void {
  runEvents.emit("run", { run_id: runId, type, payload } satisfies RunEvent);
}

// Phase 3 — shared SSE plumbing for every live stream (per-run + global execution). Handles the
// hijack/headers, a 15s heartbeat, ordered cleanup, and backpressure: if a slow consumer lets the
// server's socket buffer grow past the cap we drop that connection instead of buffering without
// bound (one stuck client must not exhaust process memory).
const SSE_HEARTBEAT_MS = 15000;
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MiB

interface SseChannel {
  write(event: string, data: unknown): void;
  onClose(callback: () => void): void;
}

function startSseChannel(request: FastifyRequest, reply: FastifyReply): SseChannel {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const closeCallbacks: Array<() => void> = [];
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    for (const callback of closeCallbacks) {
      try {
        callback();
      } catch {
        // a faulty listener-cleanup must not block the others
      }
    }
    raw.end();
  };
  const writeChunk = (chunk: string) => {
    if (closed) {
      return;
    }
    if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
      close();
      return;
    }
    try {
      raw.write(chunk);
    } catch {
      close();
    }
  };
  heartbeat = setInterval(() => writeChunk(": ping\n\n"), SSE_HEARTBEAT_MS);
  request.raw.on("close", close);
  raw.on("close", close);
  raw.on("error", close);
  return {
    write: (event, data) => writeChunk(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    onClose: (callback) => closeCallbacks.push(callback)
  };
}

const MAX_RUN_LOG_ENTRIES = 200;
const SERVER_VERSION = String(process.env.npm_package_version ?? "0.1.0");

// Phase 0 / P0-T02: bound concurrent runner containers across single and folder/stage runs.
// The limit is runtime-adjustable (persisted in settings) so operators can raise/lower how many
// containers run at once without a restart.
const runSemaphore = new Semaphore(config.max_concurrent_runs);
const settingsStore = new SettingsStore(config.storage_dir, { max_concurrent_runs: config.max_concurrent_runs });
runSemaphore.setLimit(settingsStore.read().max_concurrent_runs);

// Phase 3 (3.M9) — Stop mechanics. In-flight runs are tracked by a deterministic container name so
// a Stop request can `docker kill` the running container. `stopped` is read back when the job
// finalizes so a user-initiated stop is recorded as outcome=stopped (not a generic error).
const activeRuns = new Map<string, { container_name: string; stopped: boolean }>();
function runContainerName(runId: string): string {
  return `tsp_run_${runId}`;
}
function killRunContainer(containerName: string): void {
  try {
    // `docker kill` stops the container; with --rm it is also removed. Best-effort: a missing
    // docker CLI or an already-gone container must not throw into the request handler.
    const child = spawn("docker", ["kill", containerName], { shell: false });
    child.on("error", () => {});
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  } catch {
    // ignore
  }
}

// Stop one queued/running run: kill its container if it is executing, otherwise finalize a
// not-yet-started run directly as outcome=stopped. Shared by the single-run and batch Stop routes.
// Returns true when the run was stoppable (and thus acted on).
function stopRunInternal(runId: string): boolean {
  const run = findRun(store.readState(), runId);
  if (!run || (run.status !== "queued" && run.status !== "running")) {
    return false;
  }
  const active = activeRuns.get(runId);
  if (active) {
    active.stopped = true;
    killRunContainer(active.container_name);
    return true;
  }
  store.update((state) => {
    const target = state.runs.find((item) => item.id === runId);
    if (target && (target.status === "queued" || target.status === "running")) {
      target.status = "error";
      target.outcome = "stopped";
      target.finished_at = new Date().toISOString();
      applyPhaseTransition(target, "done", target.finished_at);
    }
  });
  emitRunEvent(runId, "run.status", { status: "error", outcome: "stopped", phase: "done" });
  appendRunLog(runId, "Run stopped by user before execution started.", { level: "warning" });
  return true;
}

// Phase 0 / P0-T03: cached, short-timeout Docker readiness probe for GET /health?ready=1
// so health polling does not spam `docker version`.
let dockerReadyCache: { ok: boolean; at: number } | null = null;
async function isDockerReadyCached(): Promise<boolean> {
  const now = Date.now();
  if (dockerReadyCache && now - dockerReadyCache.at < 5000) {
    return dockerReadyCache.ok;
  }
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { shell: false });
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, 3000);
      child.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
  dockerReadyCache = { ok, at: now };
  return ok;
}

recoverInterruptedRuns();

// Phase 2 / 2.3-2.4 — session-cookie auth helpers (manual cookie handling, no new dependency).
function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      continue;
    }
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSec: number): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

type AuthRequest = { headers: { cookie?: string; authorization?: string } };

function getSessionUser(request: AuthRequest): UserRecord | null {
  const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  return authStore.getValidSession(token)?.user ?? null;
}

function getBearerUser(request: AuthRequest): UserRecord | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return authStore.verifyToken(auth.slice(7).trim());
  }
  return null;
}

// A request is authenticated by a session cookie (browser) or a bearer PAT (agent).
function resolveRequestUser(request: AuthRequest): UserRecord | null {
  return getSessionUser(request) ?? getBearerUser(request);
}

function requireUser(request: AuthRequest, reply: FastifyReply): UserRecord | null {
  const user = resolveRequestUser(request);
  if (!user) {
    sendError(reply, 401, "Authentication required", "auth.unauthorized");
    return null;
  }
  return user;
}

function requireRole(request: AuthRequest, reply: FastifyReply, roles: UserRole[]): UserRecord | null {
  const user = requireUser(request, reply);
  if (!user) {
    return null;
  }
  if (!roles.includes(user.role)) {
    sendError(reply, 403, "Forbidden: insufficient role");
    return null;
  }
  return user;
}

// Phase 2 / 2.M3 — project server_* are write-only: never return the stored (possibly encrypted)
// secret, only whether it is configured.
interface ReachabilityResult {
  reachable: boolean;
  status?: number;
  latency_ms: number;
  error?: string;
}

// Active reachability probe for the "test availability" button. A single GET with a hard timeout;
// any HTTP response (even 4xx/5xx) means the host is up. TLS verification is intentionally relaxed:
// internal stands often use self-signed/expired certs, and a reachability check should report the
// host as up regardless of cert trust. base_url is admin-configured (not per-request user input).
function probeReachability(rawUrl: string, timeoutMs: number): Promise<ReachabilityResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      resolve({ reachable: false, latency_ms: 0, error: "invalid base_url" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      resolve({ reachable: false, latency_ms: 0, error: `unsupported protocol ${url.protocol}` });
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const startedAt = Date.now();
    let settled = false;
    const finish = (result: ReachabilityResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = lib.request(
      url,
      { method: "GET", timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        res.resume(); // drain the body; we only care about the status line
        finish({ reachable: true, status: res.statusCode, latency_ms: Date.now() - startedAt });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      finish({ reachable: false, latency_ms: Date.now() - startedAt, error: "timeout" });
    });
    req.on("error", (err) => {
      finish({ reachable: false, latency_ms: Date.now() - startedAt, error: err.message });
    });
    req.end();
  });
}

function maskProjectServerVars(record: ProjectServerVarsRecord | null, projectId: string) {
  return {
    project_id: projectId,
    server_username: record?.server_username ?? "",
    server_merchant: record?.server_merchant ?? "",
    has_password: Boolean(record?.server_password),
    has_2faotp: Boolean(record?.server_2faotp),
    extra: record?.extra ?? {},
    updated_at: record?.updated_at ?? ""
  };
}

export function createServer() {
  const app = Fastify({ logger: true });
  app.register(multipart);

  // Phase 3 (X-T04) — serve the built SPA under /app/ when present. Client-side routes fall back
  // to index.html via a scope-local notFoundHandler, so the global 404 (and /api) are untouched.
  // Skipped when apps/web has not been built, so server-only deploys keep working.
  const webDist = path.resolve(config.root_dir, "apps", "web", "dist");
  if (existsSync(path.join(webDist, "index.html"))) {
    app.register(async (instance) => {
      await instance.register(fastifyStatic, { root: webDist });
      instance.setNotFoundHandler((request, reply) => {
        if (request.method === "GET") {
          return reply.type("text/html; charset=utf-8").sendFile("index.html");
        }
        return sendError(reply, 404, "Not found");
      });
    }, { prefix: "/app" });
    app.get("/app", (_request, reply) => reply.redirect("/app/"));
  }

  // Global RBAC gate (Phase 3 / L3). Every /api route requires authentication except the public
  // login/register endpoints. A request is authenticated by ANY of: a valid session cookie, a valid
  // PAT bearer token, or the machine x-api-key. Secure by default (APP_REQUIRE_AUTH); when disabled
  // the legacy api_key-only behaviour is preserved so local/dev setups keep working.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api")) {
      return;
    }
    // Public auth endpoints must be reachable unauthenticated (you log in to obtain a session).
    if (request.url.startsWith("/api/auth/login") || request.url.startsWith("/api/auth/register")) {
      return;
    }
    // Machine credential: the agent / CI presents the shared API key.
    if (config.api_key && request.headers["x-api-key"] === config.api_key) {
      return;
    }
    // Human credential: a signed-in session cookie or a personal access token (bearer).
    if (resolveRequestUser(request)) {
      return;
    }
    if (config.require_auth) {
      return sendError(reply, 401, "Authentication required", "auth.unauthorized");
    }
    // Enforcement off: keep the historical contract — if a key is configured, still demand it.
    if (config.api_key && request.headers["x-api-key"] !== config.api_key) {
      return sendError(reply, 401, "Invalid API key");
    }
  });

  // Recover orphaned in-flight runs left by a previous process before serving requests.
  reconcileOrphanedRuns();

  // Phase 2 / 2.3 — real authentication (register / login / logout / me) + user admin (RBAC).
  app.post("/api/auth/register", async (request, reply) => {
    const body = RegisterBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "A login and a password (min 8 chars) are required");
    }
    let user: UserRecord;
    try {
      user = authStore.createUser({
        login: body.data.login,
        password: body.data.password,
        display_name: body.data.display_name
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    const session = authStore.createSession(user.id);
    setSessionCookie(reply, session.token, 7 * 24 * 3600);
    auditStore.record({ action: "user.register", actor_id: user.id, actor_login: user.login, meta: { role: user.role } });
    return toPublicUser(user);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "login and password are required");
    }
    const user = authStore.verifyCredentials(body.data.login, body.data.password);
    if (!user) {
      auditStore.record({ action: "user.login_failed", actor_login: String(body.data.login ?? "").toLowerCase() });
      return sendError(reply, 401, "Invalid login or password", "auth.invalid_credentials");
    }
    // MFA-enabled users get a short-lived challenge instead of a session; they finish at /login/mfa.
    if (user.mfa_enabled) {
      return { mfa_required: true, mfa_token: authStore.createMfaChallenge(user.id) };
    }
    authStore.recordLogin(user.id);
    const session = authStore.createSession(user.id);
    setSessionCookie(reply, session.token, 7 * 24 * 3600);
    auditStore.record({ action: "user.login", actor_id: user.id, actor_login: user.login });
    return toPublicUser(user);
  });

  // Second login step for MFA-enabled users (Phase 2 / 2-R6): exchange a password challenge + TOTP
  // (or recovery) code for a session.
  app.post("/api/auth/login/mfa", async (request, reply) => {
    const body = MfaLoginBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "mfa_token and code are required");
    }
    const user = authStore.consumeMfaChallenge(body.data.mfa_token);
    if (!user) {
      return sendError(reply, 401, "Invalid or expired login challenge");
    }
    if (!authStore.verifyMfaCode(user.id, body.data.code)) {
      auditStore.record({ action: "user.mfa_failed", actor_id: user.id, actor_login: user.login });
      return sendError(reply, 401, "Invalid authentication code", "mfa.invalid_code");
    }
    authStore.recordLogin(user.id);
    const session = authStore.createSession(user.id);
    setSessionCookie(reply, session.token, 7 * 24 * 3600);
    auditStore.record({ action: "user.login", actor_id: user.id, actor_login: user.login, meta: { mfa: true } });
    return toPublicUser(user);
  });

  // MFA enrollment (authenticated): start → returns a secret + otpauth URI; confirm → verifies a code
  // and returns one-time recovery codes; disable → requires a current code.
  app.post("/api/auth/mfa/enroll", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const enrollment = authStore.beginMfaEnrollment(user.id);
    if (!enrollment) {
      return sendError(reply, 404, "User not found");
    }
    return enrollment;
  });

  app.post("/api/auth/mfa/confirm", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = MfaCodeBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "code is required");
    }
    const result = authStore.confirmMfaEnrollment(user.id, body.data.code);
    if (!result) {
      return sendError(reply, 400, "Invalid code — start enrollment again and re-scan the secret");
    }
    auditStore.record({ action: "user.mfa_enabled", actor_id: user.id, actor_login: user.login });
    return result;
  });

  app.post("/api/auth/mfa/disable", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    if (!user.mfa_enabled) {
      return sendError(reply, 400, "MFA is not enabled");
    }
    const body = MfaCodeBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "code is required");
    }
    if (!authStore.verifyMfaCode(user.id, body.data.code)) {
      return sendError(reply, 401, "Invalid authentication code", "mfa.invalid_code");
    }
    authStore.disableMfa(user.id);
    auditStore.record({ action: "user.mfa_disabled", actor_id: user.id, actor_login: user.login });
    return { disabled: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      const current = authStore.getValidSession(token)?.user ?? null;
      authStore.deleteSession(token);
      if (current) {
        auditStore.record({ action: "user.logout", actor_id: current.id, actor_login: current.login });
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/audit", async (request, reply) => {
    if (!requireRole(request, reply, ["admin"])) {
      return;
    }
    const query = (request.query ?? {}) as { limit?: string; action?: string };
    const limit = Number(query.limit ?? "200");
    return auditStore.list({ limit: Number.isFinite(limit) ? limit : 200, action: query.action });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = resolveRequestUser(request);
    if (!user) {
      return sendError(reply, 401, "Not authenticated");
    }
    return toPublicUser(user);
  });

  // Personal access tokens for the desktop agent (Phase 2 / 2.8). Plaintext shown once.
  app.post("/api/auth/tokens", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = (request.body ?? {}) as { label?: string };
    const { token, record } = authStore.createToken(user.id, String(body.label ?? ""));
    auditStore.record({ action: "token.created", actor_id: user.id, actor_login: user.login, target: record.id });
    return { token, ...toPublicToken(record) };
  });

  app.get("/api/auth/tokens", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    return authStore.listTokens(user.id).map(toPublicToken);
  });

  app.delete("/api/auth/tokens/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { id } = request.params as { id: string };
    if (!authStore.deleteToken(user.id, id)) {
      return sendError(reply, 404, "Token not found");
    }
    auditStore.record({ action: "token.revoked", actor_id: user.id, actor_login: user.login, target: id });
    return { revoked: true, id };
  });

  app.get("/api/auth/users", async (request, reply) => {
    if (!requireRole(request, reply, ["admin"])) {
      return;
    }
    return authStore.listUsers().map(toPublicUser);
  });

  app.patch("/api/auth/users/:id", async (request, reply) => {
    const admin = requireRole(request, reply, ["admin"]);
    if (!admin) {
      return;
    }
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { role?: unknown; status?: unknown };
    let updated: UserRecord | null = authStore.findById(id);
    if (!updated) {
      return sendError(reply, 404, "User not found");
    }
    const activeAdmins = () => authStore.listUsers().filter((u) => u.role === "admin" && u.status === "active");
    if (body.role !== undefined) {
      const role = UserRoleSchema.safeParse(body.role);
      if (!role.success) {
        return sendError(reply, 400, "Invalid role");
      }
      if (updated.role === "admin" && role.data !== "admin" && activeAdmins().length <= 1) {
        return sendError(reply, 400, "Cannot demote the last active admin");
      }
      updated = authStore.setRole(id, role.data);
      auditStore.record({
        action: "user.role_changed",
        actor_id: admin.id,
        actor_login: admin.login,
        target: id,
        meta: { role: role.data }
      });
    }
    if (body.status !== undefined && updated) {
      const status = UserStatusSchema.safeParse(body.status);
      if (!status.success) {
        return sendError(reply, 400, "Invalid status");
      }
      if (updated.role === "admin" && status.data === "disabled" && activeAdmins().length <= 1) {
        return sendError(reply, 400, "Cannot disable the last active admin");
      }
      updated = authStore.setStatus(id, status.data);
      auditStore.record({
        action: "user.status_changed",
        actor_id: admin.id,
        actor_login: admin.login,
        target: id,
        meta: { status: status.data }
      });
    }
    return updated ? toPublicUser(updated) : sendError(reply, 404, "User not found");
  });

  // Phase 0 / P0-T03: liveness + optional readiness. Not under /api, so it stays open even
  // when APP_API_KEY is set. `?ready=1` adds storage + Docker checks and returns 503 if down.
  app.get("/health", async (request, reply) => {
    const liveness = {
      status: "ok",
      uptime: Math.round(process.uptime()),
      version: SERVER_VERSION,
      time: new Date().toISOString()
    };
    const readyParam = String((request.query as { ready?: string } | undefined)?.ready ?? "").toLowerCase();
    if (!readyParam || ["0", "false", "no"].includes(readyParam)) {
      return liveness;
    }
    let storageOk = true;
    try {
      store.readState();
    } catch {
      storageOk = false;
    }
    const dockerOk = await isDockerReadyCached();
    const ready = storageOk && dockerOk;
    if (!ready) {
      reply.code(503);
    }
    return { ...liveness, ready, checks: { storage: storageOk, docker: dockerOk } };
  });

  // Phase 3 (3.M3) — live run stream over SSE: a snapshot on connect, then run.phase / run.log /
  // run.status deltas. Replaces poll + location.reload(). Auth is the global /api RBAC gate
  // (session cookie for the browser EventSource, PAT/x-api-key for machines); see startSseChannel
  // for heartbeat + backpressure.
  app.get("/api/runs/:id/stream", (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.readState().runs.find((item) => item.id === id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    const channel = startSseChannel(request, reply);
    channel.write("run.snapshot", {
      id: run.id,
      status: run.status,
      phase: run.phase,
      outcome: run.outcome ?? null,
      phase_timings: run.phase_timings,
      log_entries: run.log_entries
    });
    const listener = (evt: RunEvent) => {
      if (evt.run_id === id) {
        channel.write(evt.type, evt.payload);
      }
    };
    runEvents.on("run", listener);
    channel.onClose(() => runEvents.off("run", listener));
  });

  // Phase 3 — global execution feed: live status across ALL runs so the header running-counter and
  // dashboard activity update without per-run polling. A snapshot lists currently active runs on
  // connect, then each run.status delta is forwarded with a refreshed active count.
  app.get("/api/stream/execution", (request, reply) => {
    const activeRunsSnapshot = () => {
      const runs = store
        .readState()
        .runs.filter((item) => item.status === "running" || item.status === "queued");
      return {
        active: runs.length,
        runs: runs.map((item) => ({
          id: item.id,
          scenario_id: item.scenario_id,
          batch_id: item.batch_id,
          status: item.status,
          phase: item.phase,
          started_at: item.started_at,
          triggered_at: item.triggered_at
        }))
      };
    };
    const channel = startSseChannel(request, reply);
    channel.write("execution.snapshot", activeRunsSnapshot());
    const listener = (evt: RunEvent) => {
      if (evt.type !== "run.status") {
        return;
      }
      const payload = (evt.payload ?? {}) as Record<string, unknown>;
      channel.write("execution.run", { run_id: evt.run_id, ...payload });
      channel.write("execution.active", { active: activeRunsSnapshot().active });
    };
    runEvents.on("run", listener);
    channel.onClose(() => runEvents.off("run", listener));
  });

  // Phase 3 — health stream: pushes a readiness snapshot (storage + Docker) on connect and every
  // 10s after, so the header HealthIndicator reflects backend health live. Mirrors GET /health?ready.
  app.get("/api/stream/health", (request, reply) => {
    const channel = startSseChannel(request, reply);
    let cancelled = false;
    const push = async () => {
      if (cancelled) {
        return;
      }
      let storageOk = true;
      try {
        store.readState();
      } catch {
        storageOk = false;
      }
      const dockerOk = await isDockerReadyCached();
      channel.write("health", {
        ready: storageOk && dockerOk,
        checks: { storage: storageOk, docker: dockerOk },
        time: new Date().toISOString()
      });
    };
    void push();
    const timer = setInterval(() => void push(), 10000);
    channel.onClose(() => {
      cancelled = true;
      clearInterval(timer);
    });
  });

  // Legacy server-rendered HTML UI removed (Phase 3 / 3.15). The only UI is now the React SPA
  // served under /app/; the root path redirects there. Old routes (/cabinet, /projects/:id,
  // /scenarios/:id[/code], HTML /runs[/:id]) and html.ts are gone — all data flows through /api/*.
  app.get("/", async (_request, reply) => {
    reply.redirect("/app/");
  });

  app.get("/api/projects", async () => store.readState().projects);

  // Phase 3 — create a project (project-creation wizard). An explicit id is accepted; otherwise one
  // is minted. Duplicate ids are rejected.
  app.post("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = ProjectUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Project name is required");
    }
    const id = normalizeServerFieldValue(body.data.id) || `proj_${randomUUID()}`;
    if (store.readState().projects.some((project) => project.id === id)) {
      return sendError(reply, 409, `Project already exists: ${id}`);
    }
    const created: ProjectRecord = {
      id,
      name: body.data.name.trim(),
      description: body.data.description?.trim() || null
    };
    store.update((state) => {
      state.projects.push(created);
    });
    auditStore.record({ action: "project.create", actor_id: user.id, actor_login: user.login, target: id });
    return created;
  });

  // Runtime execution settings — currently the max number of runner containers that run at once.
  app.get("/api/settings", async () => ({ max_concurrent_runs: runSemaphore.getLimit() }));

  app.put("/api/settings", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const saved = settingsStore.write((request.body ?? {}) as { max_concurrent_runs?: unknown });
    runSemaphore.setLimit(saved.max_concurrent_runs);
    auditStore.record({
      action: "settings.update",
      actor_id: user.id,
      actor_login: user.login,
      meta: { max_concurrent_runs: saved.max_concurrent_runs }
    });
    return { max_concurrent_runs: runSemaphore.getLimit() };
  });

  app.get("/api/runs", async (request) => {
    const state = store.readState();
    const limit = normalizeRecentRunsLimit((request.query as { limit?: string | number }).limit);
    return {
      limit,
      runs: listRecentRuns(state, limit ?? undefined)
    };
  });

  // Phase 3 (2-R11) — batch aggregates for the batch screen. A batch is the set of runs sharing a
  // batch_id (repeated single-scenario run or folder/stage run). Optional ?project_id filters.
  app.get("/api/batches", async (request) => {
    const state = store.readState();
    const query = (request.query ?? {}) as { limit?: string | number; project_id?: string };
    const limit = normalizeRecentRunsLimit(query.limit);
    let batches = summarizeBatches(state, limit ?? undefined);
    if (query.project_id) {
      batches = batches.filter((batch) => batch.project_id === query.project_id);
    }
    return { limit, batches };
  });

  app.get("/api/batches/:batch_id", async (request, reply) => {
    const { batch_id } = request.params as { batch_id: string };
    const batch = summarizeBatch(store.readState(), batch_id);
    if (!batch) {
      return sendError(reply, 404, "Batch not found", "batch.not_found");
    }
    return batch;
  });

  // Phase 3 — live batch stream: a batch.snapshot aggregate on connect, then a batch.run delta plus a
  // refreshed batch.aggregate whenever a member run changes. Members added later (retry-failed /
  // complete) are picked up lazily when their first event arrives. Same RBAC gate + SSE plumbing as
  // the run/execution streams.
  app.get("/api/batches/:batch_id/stream", (request, reply) => {
    const { batch_id } = request.params as { batch_id: string };
    const snapshot = summarizeBatch(store.readState(), batch_id);
    if (!snapshot) {
      return sendError(reply, 404, "Batch not found", "batch.not_found");
    }
    const memberIds = new Set(
      store.readState().runs.filter((run) => run.batch_id === batch_id).map((run) => run.id)
    );
    const channel = startSseChannel(request, reply);
    channel.write("batch.snapshot", snapshot);
    const listener = (evt: RunEvent) => {
      if (!memberIds.has(evt.run_id)) {
        // Fast path miss: a run we haven't seen. It may be a freshly-added batch member.
        const run = findRun(store.readState(), evt.run_id);
        if (run?.batch_id !== batch_id) {
          return;
        }
        memberIds.add(evt.run_id);
      }
      channel.write("batch.run", { run_id: evt.run_id, type: evt.type, ...(evt.payload as object) });
      const aggregate = summarizeBatch(store.readState(), batch_id);
      if (aggregate) {
        channel.write("batch.aggregate", aggregate);
      }
    };
    runEvents.on("run", listener);
    channel.onClose(() => runEvents.off("run", listener));
  });

  app.get("/api/projects/:project_id/environments", async (request) => {
    const { project_id } = request.params as { project_id: string };
    return store.readState().environments.filter((env) => env.project_id === project_id);
  });

  // Phase 3 — create an environment for a project (project-creation wizard). An environment is a hard
  // prerequisite: scenarios can only be uploaded/run against an env that already exists.
  app.post("/api/projects/:project_id/environments", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { project_id } = request.params as { project_id: string };
    if (!store.readState().projects.some((project) => project.id === project_id)) {
      return sendError(reply, 404, "Project not found", "project.not_found");
    }
    const body = EnvironmentUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Environment name and base_url are required");
    }
    const id = normalizeServerFieldValue(body.data.id) || `env_${randomUUID()}`;
    if (store.readState().environments.some((env) => env.id === id)) {
      return sendError(reply, 409, `Environment already exists: ${id}`);
    }
    const created: EnvironmentRecord = {
      id,
      project_id,
      name: body.data.name.trim(),
      base_url: body.data.base_url.trim(),
      is_default: Boolean(body.data.is_default)
    };
    store.update((state) => {
      // A newly-marked default demotes the project's other defaults so only one remains.
      if (created.is_default) {
        for (const env of state.environments) {
          if (env.project_id === project_id) {
            env.is_default = false;
          }
        }
      }
      state.environments.push(created);
    });
    auditStore.record({ action: "environment.create", actor_id: user.id, actor_login: user.login, target: id });
    return created;
  });

  // "Test availability" button (Phase 3 / 3.11). Requires a signed-in user since it triggers an
  // outbound request; the URL itself is the admin-configured environment base_url, not user input.
  app.post("/api/environments/:env_id/reachability", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { env_id } = request.params as { env_id: string };
    const env = store.readState().environments.find((e) => e.id === env_id);
    if (!env) {
      return sendError(reply, 404, "Environment not found");
    }
    const result = await probeReachability(env.base_url, 5000);
    return { env_id, base_url: env.base_url, checked_at: new Date().toISOString(), ...result };
  });

  app.get("/api/projects/:project_id/scenarios", async (request) => {
    const { project_id } = request.params as { project_id: string };
    return store.readState().scenarios.filter((scenario) => scenario.project_id === project_id);
  });

  // Phase 3 (3.8) — write-only over the API too: list logins + "is configured" flags, never the
  // stored password/TOTP secret. (HTML pages were sanitized in P0-T05; this closes the JSON path.)
  app.get("/api/accounts", async (request) => {
    // Optional ?project_id returns that project's accounts plus the global (project_id null) ones.
    const filter = String((request.query as { project_id?: string } | undefined)?.project_id ?? "").trim();
    return store
      .readState()
      .accounts.slice()
      .filter((account) => !filter || !account.project_id || account.project_id === filter)
      .sort((left, right) => left.login.localeCompare(right.login))
      .map((account) => ({
        login: account.login,
        project_id: account.project_id ?? null,
        has_password: Boolean(String(account.password ?? "").trim()),
        has_totp: Boolean(String(account["2fa_otp"] ?? "").trim()),
        created_at: account.created_at,
        updated_at: account.updated_at
      }));
  });

  app.post("/api/accounts", async (request, reply) => {
    const body = AccountUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Account login is required");
    }
    const login = normalizeServerFieldValue(body.data.login);
    if (!login) {
      return sendError(reply, 400, "Account login is required");
    }
    // Phase 0 / P0-T05: write-only secret edits. An absent/empty password or 2fa_otp keeps
    // the stored value; a password is only mandatory when creating a new account.
    const passwordProvided = String(body.data.password ?? "").trim().length > 0;
    const password = String(body.data.password ?? "").trim();
    const otpProvided = String(body.data["2fa_otp"] ?? "").trim().length > 0;
    let twoFactorOtp = "";
    if (otpProvided) {
      try {
        twoFactorOtp = normalizeAccountOtpValue(body.data["2fa_otp"]);
      } catch (error) {
        return sendError(reply, 400, error instanceof Error ? error.message : String(error));
      }
    }
    // Phase 2 / 2-R9 — accounts are unique per (project_id, login), so the same login can exist as a
    // global default and scoped to a project. project_id null = global.
    const projectId = body.data.project_id ?? null;
    const matches = (item: AccountRecord) => item.login === login && (item.project_id ?? null) === projectId;
    const existingAccount = store.readState().accounts.find(matches);
    if (!existingAccount && !passwordProvided) {
      return sendError(reply, 400, "A password is required when creating a new account");
    }
    const now = new Date().toISOString();
    return store.update((state) => {
      const existing = state.accounts.find(matches);
      if (existing) {
        if (passwordProvided) {
          existing.password = sealSecret(password);
        }
        if (otpProvided) {
          existing["2fa_otp"] = sealSecret(twoFactorOtp);
        }
        existing.updated_at = now;
        return existing;
      }
      const created: AccountRecord = {
        login,
        password: sealSecret(password),
        "2fa_otp": otpProvided ? sealSecret(twoFactorOtp) : "",
        project_id: projectId,
        created_at: now,
        updated_at: now
      };
      state.accounts.push(created);
      return created;
    });
  });

  app.delete("/api/accounts/:login", async (request, reply) => {
    const { login } = request.params as { login: string };
    const normalized = normalizeServerFieldValue(login);
    if (!normalized) {
      return sendError(reply, 400, "Account login is required");
    }
    // Phase 2 / 2-R9 — an explicit ?project_id scopes the delete so a project-scoped account and a
    // global one with the same login can be removed independently.
    const scope = (request.query as { project_id?: string } | undefined)?.project_id;
    const projectId = typeof scope === "string" && scope.trim() ? scope.trim() : null;
    const scoped = typeof scope === "string";
    const deleted = store.update((state) => {
      const index = state.accounts.findIndex(
        (item) => item.login === normalized && (!scoped || (item.project_id ?? null) === projectId)
      );
      if (index < 0) {
        return false;
      }
      state.accounts.splice(index, 1);
      return true;
    });
    if (!deleted) {
      return sendError(reply, 404, "Account not found", "account.not_found");
    }
    return { deleted: true, login: normalized };
  });

  // Phase 2 / 2.M3 — per-project default server_* values (multiproject).
  app.get("/api/projects/:project_id/server-vars", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const state = store.readState();
    if (!state.projects.find((p) => p.id === project_id)) {
      return sendError(reply, 404, "Project not found", "project.not_found");
    }
    const record = state.project_server_vars.find((v) => v.project_id === project_id) ?? null;
    return maskProjectServerVars(record, project_id);
  });

  app.post("/api/projects/:project_id/server-vars", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    if (!store.readState().projects.find((p) => p.id === project_id)) {
      return sendError(reply, 404, "Project not found", "project.not_found");
    }
    const body = (request.body ?? {}) as {
      server_username?: string;
      server_password?: string;
      server_2faotp?: string;
      server_merchant?: string;
      extra?: Record<string, string>;
    };
    const now = new Date().toISOString();
    const result = store.update((state) => {
      let record = state.project_server_vars.find((v) => v.project_id === project_id);
      if (!record) {
        record = {
          project_id,
          server_username: "",
          server_password: "",
          server_2faotp: "",
          server_merchant: "",
          extra: {},
          created_at: now,
          updated_at: now
        };
        state.project_server_vars.push(record);
      }
      if (typeof body.server_username === "string") {
        record.server_username = body.server_username.trim();
      }
      if (typeof body.server_merchant === "string") {
        record.server_merchant = body.server_merchant.trim();
      }
      // Write-only secrets: a non-empty value replaces; empty keeps the stored one.
      if (typeof body.server_password === "string" && body.server_password.trim()) {
        record.server_password = sealSecret(body.server_password.trim());
      }
      if (typeof body.server_2faotp === "string" && body.server_2faotp.trim()) {
        record.server_2faotp = sealSecret(body.server_2faotp.trim());
      }
      if (body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)) {
        record.extra = Object.fromEntries(Object.entries(body.extra).map(([k, v]) => [k, String(v ?? "")]));
      }
      record.updated_at = now;
      return record;
    });
    return maskProjectServerVars(result, project_id);
  });

  app.delete("/api/projects/:project_id/server-vars", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const removed = store.update((state) => {
      const idx = state.project_server_vars.findIndex((v) => v.project_id === project_id);
      if (idx < 0) {
        return false;
      }
      state.project_server_vars.splice(idx, 1);
      return true;
    });
    if (!removed) {
      return sendError(reply, 404, "No server vars configured for this project");
    }
    return { deleted: true, project_id };
  });

  app.post("/api/accounts/code", async (request, reply) => {
    const body = AccountOtpCodeCreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Account login is required");
    }
    const login = normalizeServerFieldValue(body.data.login);
    if (!login) {
      return sendError(reply, 400, "Account login is required");
    }
    const account = store.readState().accounts.find((item) => item.login === login);
    if (!account) {
      return sendError(reply, 404, "Account not found", "account.not_found");
    }
    const secret = tryNormalizeTotpSecret(openSecret(account["2fa_otp"]));
    if (!secret) {
      return sendError(reply, 400, "Account does not have 2FA OTP configured");
    }
    const otp = generateTotpCodeSafeDetails(secret);
    const codeActor = getSessionUser(request);
    auditStore.record({
      action: "credential.totp_code_issued",
      actor_id: codeActor?.id ?? null,
      actor_login: codeActor?.login ?? null,
      target: login
    });
    return {
      login,
      code: otp.code,
      generated_at: new Date().toISOString(),
      expires_in_sec: otp.expires_in_sec,
      period: otp.period,
      digits: otp.digits
    };
  });

  app.get("/api/merchants", async (request) => {
    const filter = String((request.query as { project_id?: string } | undefined)?.project_id ?? "").trim();
    return store
      .readState()
      .merchants.slice()
      .filter((merchant) => !filter || !merchant.project_id || merchant.project_id === filter)
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  app.post("/api/merchants", async (request, reply) => {
    const body = MerchantUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Merchant name is required");
    }
    const name = normalizeServerFieldValue(body.data.name);
    if (!name) {
      return sendError(reply, 400, "Merchant name is required");
    }
    const adminLogin = normalizeOptionalServerFieldValue(body.data.admin_login);
    const envIds = normalizeStringList(body.data.env_ids);
    const projectId = body.data.project_id ?? null;
    const currentState = store.readState();
    if (adminLogin && !currentState.accounts.some((account) => account.login === adminLogin)) {
      return sendError(reply, 400, `Admin account not found: ${adminLogin}`);
    }
    const matches = (item: MerchantRecord) => item.name === name && (item.project_id ?? null) === projectId;
    const now = new Date().toISOString();
    return store.update((state) => {
      const existing = state.merchants.find(matches);
      if (existing) {
        existing.admin_login = adminLogin;
        existing.env_ids = envIds;
        existing.updated_at = now;
        return existing;
      }
      const created: MerchantRecord = {
        name,
        admin_login: adminLogin,
        env_ids: envIds,
        project_id: projectId,
        created_at: now,
        updated_at: now
      };
      state.merchants.push(created);
      return created;
    });
  });

  app.delete("/api/merchants/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const normalized = normalizeServerFieldValue(name);
    if (!normalized) {
      return sendError(reply, 400, "Merchant name is required");
    }
    const scope = (request.query as { project_id?: string } | undefined)?.project_id;
    const projectId = typeof scope === "string" && scope.trim() ? scope.trim() : null;
    const scoped = typeof scope === "string";
    const deleted = store.update((state) => {
      const index = state.merchants.findIndex(
        (item) => item.name === normalized && (!scoped || (item.project_id ?? null) === projectId)
      );
      if (index < 0) {
        return false;
      }
      state.merchants.splice(index, 1);
      return true;
    });
    if (!deleted) {
      return sendError(reply, 404, "Merchant not found", "merchant.not_found");
    }
    return { deleted: true, name: normalized };
  });

  app.get("/api/pools", async (request) => {
    const query = request.query as { kind?: string; project_id?: string; env_id?: string };
    const state = store.readState();
    return state.pools
      .filter((pool) => !query.kind || pool.kind === query.kind)
      .filter((pool) => !query.project_id || !pool.project_id || pool.project_id === query.project_id)
      .filter((pool) => !query.env_id || pool.env_ids.length === 0 || pool.env_ids.includes(query.env_id))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  });

  app.post("/api/pools", async (request, reply) => {
    const body = PoolUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid pool payload");
    }
    const id = normalizeServerFieldValue(body.data.id) || `pool_${randomUUID()}`;
    const name = normalizeServerFieldValue(body.data.name);
    if (!name) {
      return sendError(reply, 400, "Pool name is required");
    }
    const now = new Date().toISOString();
    return store.update((state) => {
      const existing = state.pools.find((item) => item.id === id);
      const next: PoolRecord = {
        id,
        name,
        kind: body.data.kind,
        project_id: normalizeOptionalServerFieldValue(body.data.project_id),
        env_ids: normalizeStringList(body.data.env_ids),
        dedupe: body.data.dedupe ?? true,
        allocation_strategy: body.data.allocation_strategy ?? "manual",
        template: String(body.data.template ?? ""),
        fetch_scenario_id: normalizeOptionalServerFieldValue(body.data.fetch_scenario_id),
        fetch_input_name: normalizeServerFieldValue(body.data.fetch_input_name) || "addresses_json",
        fetch_output_key: normalizeServerFieldValue(body.data.fetch_output_key) || "address_info",
        auto_import_enabled: body.data.auto_import_enabled ?? false,
        auto_import_scenario_id: normalizeOptionalServerFieldValue(body.data.auto_import_scenario_id),
        auto_import_output_key: normalizeServerFieldValue(body.data.auto_import_output_key),
        auto_import_mode: body.data.auto_import_mode ?? "whole",
        auto_import_json_path: normalizeServerFieldValue(body.data.auto_import_json_path),
        created_at: existing?.created_at ?? now,
        updated_at: now
      };
      if (existing) {
        Object.assign(existing, next);
        return existing;
      }
      state.pools.push(next);
      return next;
    });
  });

  app.delete("/api/pools/:pool_id", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const deleted = store.update((state) => {
      const index = state.pools.findIndex((item) => item.id === pool_id);
      if (index < 0) {
        return false;
      }
      state.pools.splice(index, 1);
      state.pool_items = state.pool_items.filter((item) => item.pool_id !== pool_id);
      return true;
    });
    if (!deleted) {
      return sendError(reply, 404, "Pool not found", "pool.not_found");
    }
    return { deleted: true, pool_id };
  });

  app.get("/api/pools/:pool_id/items", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const state = store.readState();
    if (!state.pools.some((pool) => pool.id === pool_id)) {
      return sendError(reply, 404, "Pool not found", "pool.not_found");
    }
    return state.pool_items
      .filter((item) => item.pool_id === pool_id)
      .sort((left, right) => left.value.localeCompare(right.value));
  });

  app.post("/api/pools/:pool_id/items", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const body = PoolItemUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid pool item payload");
    }
    const id = normalizeServerFieldValue(body.data.id) || `pool_item_${randomUUID()}`;
    const value = normalizeServerFieldValue(body.data.value);
    if (!value) {
      return sendError(reply, 400, "Pool item value is required");
    }
    const now = new Date().toISOString();
    try {
      return store.update((state) => upsertPoolItem(state, pool_id, id, value, body.data, now));
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  // Bulk add pool items — one value per line (the client splits on newline). Each value is trimmed and
  // blank/duplicate lines are dropped; id + label are auto-generated. One store.update for the whole
  // paste instead of one round-trip per line.
  app.post("/api/pools/:pool_id/items/bulk", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const body = PoolItemBulkBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid bulk pool item payload");
    }
    const snapshot = store.readState();
    if (!snapshot.pools.some((pool) => pool.id === pool_id)) {
      return sendError(reply, 404, "Pool not found", "pool.not_found");
    }
    // Trim each line, drop blanks, and dedupe within the request (keep first-seen order).
    const seen = new Set<string>();
    const values: string[] = [];
    for (const raw of body.data.values) {
      const value = normalizeServerFieldValue(raw);
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      values.push(value);
    }
    if (values.length === 0) {
      return sendError(reply, 400, "No non-empty values to add");
    }
    const now = new Date().toISOString();
    try {
      const items = store.update((state) =>
        values.map((value) => upsertPoolItem(state, pool_id, `pool_item_${randomUUID()}`, value, {}, now))
      );
      return { created: items.length, items };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/api/pools/:pool_id/items/:item_id", async (request, reply) => {
    const { pool_id, item_id } = request.params as { pool_id: string; item_id: string };
    const body = PoolItemUpsertBodySchema.partial().safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid pool item payload");
    }
    const updated = store.update((state) => {
      const item = state.pool_items.find((entry) => entry.pool_id === pool_id && entry.id === item_id);
      if (!item) {
        return null;
      }
      if (body.data.value !== undefined) {
        item.value = normalizeServerFieldValue(body.data.value);
      }
      if (body.data.label !== undefined) {
        item.label = String(body.data.label ?? "");
      }
      if (body.data.enabled !== undefined) {
        item.enabled = Boolean(body.data.enabled);
      }
      if (body.data.currency !== undefined) {
        item.currency = normalizeServerFieldValue(body.data.currency);
      }
      if (body.data.network !== undefined) {
        item.network = normalizeServerFieldValue(body.data.network);
      }
      if (body.data.metadata !== undefined) {
        item.metadata = body.data.metadata;
      }
      item.updated_at = new Date().toISOString();
      return item;
    });
    if (!updated) {
      return sendError(reply, 404, "Pool item not found");
    }
    return updated;
  });

  app.delete("/api/pools/:pool_id/items/:item_id", async (request, reply) => {
    const { pool_id, item_id } = request.params as { pool_id: string; item_id: string };
    const deleted = store.update((state) => {
      const index = state.pool_items.findIndex((item) => item.pool_id === pool_id && item.id === item_id);
      if (index < 0) {
        return false;
      }
      state.pool_items.splice(index, 1);
      return true;
    });
    if (!deleted) {
      return sendError(reply, 404, "Pool item not found");
    }
    return { deleted: true, pool_id, item_id };
  });

  app.post("/api/runs/:run_id/outputs/:output_key/add-to-pool", async (request, reply) => {
    const { run_id, output_key } = request.params as { run_id: string; output_key: string };
    const body = RunOutputAddToPoolBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "Invalid output import payload");
    }
    const state = store.readState();
    const run = findRun(state, run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    const scenario = findScenario(state, run.scenario_id);
    const outputs = readRunOutputs(run);
    if (!(output_key in outputs)) {
      return sendError(reply, 404, "Output key not found");
    }

    let poolId = body.data.pool_id;
    if (body.data.create_pool) {
      const now = new Date().toISOString();
      const poolBody = body.data.create_pool;
      poolId = normalizeServerFieldValue(poolBody.id) || `pool_${randomUUID()}`;
      store.update((nextState) => {
        if (!nextState.pools.some((pool) => pool.id === poolId)) {
          nextState.pools.push({
            id: poolId,
            name: normalizeServerFieldValue(poolBody.name) || poolId,
            kind: poolBody.kind,
            project_id: normalizeOptionalServerFieldValue(poolBody.project_id),
            env_ids: normalizeStringList(poolBody.env_ids),
            dedupe: poolBody.dedupe ?? true,
            allocation_strategy: poolBody.allocation_strategy ?? "manual",
            template: String(poolBody.template ?? ""),
            fetch_scenario_id: normalizeOptionalServerFieldValue(poolBody.fetch_scenario_id),
            fetch_input_name: normalizeServerFieldValue(poolBody.fetch_input_name) || "addresses_json",
            fetch_output_key: normalizeServerFieldValue(poolBody.fetch_output_key) || "address_info",
            auto_import_enabled: poolBody.auto_import_enabled ?? false,
            auto_import_scenario_id: normalizeOptionalServerFieldValue(poolBody.auto_import_scenario_id),
            auto_import_output_key: normalizeServerFieldValue(poolBody.auto_import_output_key),
            auto_import_mode: poolBody.auto_import_mode ?? "whole",
            auto_import_json_path: normalizeServerFieldValue(poolBody.auto_import_json_path),
            created_at: now,
            updated_at: now
          });
        }
      });
    }

    const values = extractOutputValues(outputs[output_key], {
      mode: body.data.mode,
      jsonPath: body.data.json_path
    });
    if (values.length === 0) {
      return sendError(reply, 400, "Output value is empty");
    }
    const now = new Date().toISOString();
    try {
      const imported = store.update((nextState) => {
        const pool = nextState.pools.find((item) => item.id === poolId);
        if (!pool) {
          throw new Error("Pool not found");
        }
        return values.map((value) =>
          upsertPoolItem(nextState, pool.id, `pool_item_${randomUUID()}`, value, {
            source: {
              type: "run_output",
              run_id,
              scenario_id: scenario?.id ?? run.scenario_id,
              output_key
            }
          }, now)
        );
      });
      return { pool_id: poolId, imported_count: imported.length, items: imported };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/pools/:pool_id/import-run-outputs", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const body = PoolImportRunOutputsBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "Invalid bulk import payload");
    }
    const state = store.readState();
    const pool = state.pools.find((item) => item.id === pool_id);
    if (!pool) {
      return sendError(reply, 404, "Pool not found", "pool.not_found");
    }
    const status = body.data.status ?? "passed";
    const candidateRuns = state.runs.filter(
      (run) =>
        run.status === status &&
        (!body.data.scenario_id || run.scenario_id === body.data.scenario_id)
    );
    let importedCount = 0;
    const now = new Date().toISOString();
    try {
      store.update((nextState) => {
        for (const run of candidateRuns) {
          const outputs = readRunOutputs(run);
          if (!(body.data.output_key in outputs)) {
            continue;
          }
          const values = extractOutputValues(outputs[body.data.output_key], {
            mode: body.data.mode,
            jsonPath: body.data.json_path
          });
          for (const value of values) {
            upsertPoolItem(nextState, pool_id, `pool_item_${randomUUID()}`, value, {
              source: {
                type: "run_output",
                run_id: run.id,
                scenario_id: run.scenario_id,
                output_key: body.data.output_key
              }
            }, now);
            importedCount += 1;
          }
        }
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    return { pool_id, imported_count: importedCount };
  });

  app.post("/api/pools/:pool_id/fetch", async (request, reply) => {
    const { pool_id } = request.params as { pool_id: string };
    const state = store.readState();
    const pool = state.pools.find((item) => item.id === pool_id);
    if (!pool) {
      return sendError(reply, 404, "Pool not found", "pool.not_found");
    }
    if (!pool.fetch_scenario_id) {
      return sendError(reply, 400, "Pool does not have fetch_scenario_id configured");
    }
    const scenario = findScenario(state, pool.fetch_scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Fetch scenario not found");
    }
    const items = state.pool_items
      .filter((item) => item.pool_id === pool_id && item.enabled)
      .map((item) => ({
        id: item.id,
        value: item.value,
        label: item.label,
        currency: item.currency,
        network: item.network,
        metadata: item.metadata
      }));
    let plan: PreparedRunPlan;
    try {
      plan = prepareScenarioRunPlan(state, scenario, {
        inputs: {
          [pool.fetch_input_name || "addresses_json"]: JSON.stringify(items)
        },
        triggered_by: "pool-fetch"
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    plan.run.runtime_snapshot = {
      ...plan.run.runtime_snapshot,
      pool_fetch: {
        pool_id,
        output_key: pool.fetch_output_key || "address_info",
        item_count: items.length
      }
    };
    store.update((nextState) => {
      nextState.runs.push(plan.run);
    });
    enqueueRunExecution(plan);
    return { pool_id, run: plan.run, item_count: items.length };
  });

  app.get("/api/scenarios/:scenario_id", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    return scenario;
  });

  // Scenario source (Phase 3): the recorded scenario.spec.ts read out of the package zip, for the
  // read-only code viewer in the SPA.
  app.get("/api/scenarios/:scenario_id/code", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    try {
      return { scenario_id, filename: SCENARIO_FILE_NAME, code: readScenarioSource(scenario.package_path) };
    } catch (error) {
      return sendError(reply, 404, error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    return run;
  });

  app.post("/api/runs/:run_id/retry", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const retryBody = normalizeRetryRunBody(request.body);
    const state = store.readState();
    const run = findRun(state, run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    const scenario = findScenario(state, run.scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    let plan: PreparedRunPlan;
    try {
      plan = prepareScenarioRunPlan(state, scenario, {
        env_id: run.env_id ?? scenario.env_id,
        account_login: run.account_login ?? undefined,
        merchant_name: run.merchant_name ?? undefined,
        server_username: retryBody.server_username ?? run.server_username ?? undefined,
        server_password: retryBody.server_password ?? run.server_password ?? undefined,
        server_2faotp: retryBody.server_2faotp ?? run.server_2faotp ?? undefined,
        server_merchant: retryBody.server_merchant ?? run.server_merchant ?? undefined,
        inputs: buildRetryInputs(run, scenario, retryBody.inputs),
        pool_selections: run.pool_selections ?? {},
        ignore_variables: run.ignore_variables,
        ignored_inputs: run.ignored_inputs,
        runtime_snapshot: run.runtime_snapshot ?? {},
        retry_of_run_id: run.id,
        execution_stage: run.execution_stage,
        default_timeout_ms: retryBody.has_default_timeout_ms
          ? (retryBody.default_timeout_ms ?? undefined)
          : (run.default_timeout_ms ?? undefined),
        triggered_by: "retry"
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    store.update((nextState) => {
      nextState.runs.push(plan.run);
    });
    enqueueRunExecution(plan);
    return plan.run;
  });

  // Stop a queued/running run (Phase 3 / 3.M9). Kills the runner container by its deterministic
  // name; the executor records the run as outcome=stopped when it unwinds. Marking stopped in the
  // registry also covers a run that is still queued (no container yet) — it finalizes as stopped.
  app.post("/api/runs/:run_id/stop", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    if (run.status !== "queued" && run.status !== "running") {
      return sendError(reply, 409, `Run is not stoppable (status: ${run.status})`);
    }
    stopRunInternal(run_id);
    auditStore.record({ action: "run.stop", actor_id: user.id, actor_login: user.login, target: run_id });
    return { stopped: true, run_id };
  });

  // Batch bulk actions (Phase 3 / 2-R11). Stop every still-active member; retry every failed/errored
  // member back into the SAME batch so the screen shows the fresh attempts alongside the originals.
  app.post("/api/batches/:batch_id/stop", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { batch_id } = request.params as { batch_id: string };
    const members = store.readState().runs.filter((run) => run.batch_id === batch_id);
    if (members.length === 0) {
      return sendError(reply, 404, "Batch not found", "batch.not_found");
    }
    let stopped = 0;
    for (const run of members) {
      if (run.status === "queued" || run.status === "running") {
        if (stopRunInternal(run.id)) {
          stopped += 1;
        }
      }
    }
    auditStore.record({
      action: "batch.stop",
      actor_id: user.id,
      actor_login: user.login,
      target: batch_id,
      meta: { stopped }
    });
    return { batch_id, stopped };
  });

  app.post("/api/batches/:batch_id/retry-failed", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { batch_id } = request.params as { batch_id: string };
    const state = store.readState();
    const members = state.runs.filter((run) => run.batch_id === batch_id);
    if (members.length === 0) {
      return sendError(reply, 404, "Batch not found", "batch.not_found");
    }
    // Retry runs that failed or errored, but not ones the user deliberately stopped.
    const failed = members.filter(
      (run) => (run.status === "failed" || run.status === "error") && run.outcome !== "stopped"
    );
    const plans = failed
      .map((run) => buildBatchMemberPlan(state, run, batch_id))
      .filter((plan): plan is PreparedRunPlan => plan !== null);
    if (plans.length > 0) {
      store.update((nextState) => {
        nextState.runs.push(...plans.map((plan) => plan.run));
      });
      enqueueFolderRunExecution(plans);
    }
    auditStore.record({
      action: "batch.retry_failed",
      actor_id: user.id,
      actor_login: user.login,
      target: batch_id,
      meta: { retried: plans.length }
    });
    return { batch_id, retried: plans.length, runs: plans.map((plan) => plan.run) };
  });

  // Top up a batch so every scenario reaches its declared amount_times_to_run of PASSED runs
  // ("Дозавершить"). For each scenario the gap = target - passed; that many fresh runs are queued
  // into the same batch, cloned from the latest member. No-op once every scenario has enough passes.
  app.post("/api/batches/:batch_id/complete", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { batch_id } = request.params as { batch_id: string };
    const state = store.readState();
    const members = state.runs.filter((run) => run.batch_id === batch_id);
    if (members.length === 0) {
      return sendError(reply, 404, "Batch not found", "batch.not_found");
    }
    const byScenario = new Map<string, RunRecord[]>();
    for (const run of members) {
      const group = byScenario.get(run.scenario_id) ?? [];
      group.push(run);
      byScenario.set(run.scenario_id, group);
    }
    const plans: PreparedRunPlan[] = [];
    for (const [, scenarioRuns] of byScenario) {
      const target = Math.max(...scenarioRuns.map((run) => run.amount_times_to_run || 1));
      const passed = scenarioRuns.filter((run) => run.status === "passed").length;
      const missing = Math.max(0, target - passed);
      if (missing === 0) {
        continue;
      }
      // Clone from the most recently triggered member so the latest inputs/selection carry over.
      const source = scenarioRuns
        .slice()
        .sort((left, right) => String(right.triggered_at).localeCompare(String(left.triggered_at)))[0];
      for (let index = 0; index < missing; index += 1) {
        const plan = buildBatchMemberPlan(state, source, batch_id, {
          amount_times_to_run: target,
          run_iteration: Math.min(target, passed + index + 1),
          triggered_by: "topup"
        });
        if (plan) {
          plans.push(plan);
        }
      }
    }
    if (plans.length > 0) {
      store.update((nextState) => {
        nextState.runs.push(...plans.map((plan) => plan.run));
      });
      enqueueFolderRunExecution(plans);
    }
    auditStore.record({
      action: "batch.complete",
      actor_id: user.id,
      actor_login: user.login,
      target: batch_id,
      meta: { added: plans.length }
    });
    return { batch_id, added: plans.length, runs: plans.map((plan) => plan.run) };
  });

  app.post("/api/projects/:project_id/folders", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const body = FolderCreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Folder path is required");
    }
    const folderPath = normalizeFolderPath(body.data.path);
    if (!folderPath) {
      return sendError(reply, 400, "Folder path is required");
    }
    try {
      const target = safeJoin(projectRootDir(config.storage_dir, project_id), folderPath);
      if (existsSync(target) && isScenarioDir(target)) {
        return sendError(reply, 400, "Path conflicts with a scenario folder");
      }
      mkdirSync(target, { recursive: true });
      return { path: folderPath };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/projects/:project_id/folders/move", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const body = FolderMoveBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid folder move payload");
    }
    const fromPath = normalizeFolderPath(body.data.from_path);
    const toPath = normalizeFolderPath(body.data.to_path);
    if (!fromPath) {
      return sendError(reply, 400, "Cannot move project root");
    }
    if (!toPath) {
      return sendError(reply, 400, "Target path is required");
    }
    if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
      return sendError(reply, 400, "Invalid target path");
    }
    try {
      const root = projectRootDir(config.storage_dir, project_id);
      const sourceDir = safeJoin(root, fromPath);
      const targetDir = safeJoin(root, toPath);
      if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        return sendError(reply, 404, "Folder not found");
      }
      if (isScenarioDir(sourceDir)) {
        return sendError(reply, 400, "Cannot move a scenario folder");
      }
      if (existsSync(targetDir)) {
        return sendError(reply, 400, "Target already exists");
      }
      mkdirSync(path.dirname(targetDir), { recursive: true });
      renameSync(sourceDir, targetDir);
      store.update((state) => {
        const scenarioIds: string[] = [];
        for (const scenario of state.scenarios) {
          if (scenario.project_id !== project_id) {
            continue;
          }
          if (scenario.folder_path === fromPath) {
            scenario.folder_path = toPath;
          } else if (scenario.folder_path.startsWith(`${fromPath}/`)) {
            scenario.folder_path = `${toPath}${scenario.folder_path.slice(fromPath.length)}`;
          } else {
            continue;
          }
          scenario.package_path = repath(sourceDir, targetDir, scenario.package_path) ?? scenario.package_path;
          scenarioIds.push(scenario.id);
        }
        for (const run of state.runs) {
          if (!scenarioIds.includes(run.scenario_id)) {
            continue;
          }
          run.artifacts_path = repath(sourceDir, targetDir, run.artifacts_path) ?? run.artifacts_path;
          run.stdout_path = repath(sourceDir, targetDir, run.stdout_path) ?? run.stdout_path;
          run.stderr_path = repath(sourceDir, targetDir, run.stderr_path) ?? run.stderr_path;
        }
      });
      return { from: fromPath, to: toPath };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/projects/:project_id/folders", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const folderPath = normalizeFolderPath((request.query as { path?: string }).path ?? "");
    if (!folderPath) {
      return sendError(reply, 400, "Cannot delete project root");
    }
    try {
      const target = safeJoin(projectRootDir(config.storage_dir, project_id), folderPath);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        return sendError(reply, 404, "Folder not found");
      }
      if (isScenarioDir(target)) {
        return sendError(reply, 400, "Use scenario delete for scenario folders");
      }
      const deletedScenarioIds = store.update((state) => {
        const ids = state.scenarios
          .filter(
            (scenario) =>
              scenario.project_id === project_id &&
              (scenario.folder_path === folderPath || scenario.folder_path.startsWith(`${folderPath}/`))
          )
          .map((scenario) => scenario.id);
        state.scenarios = state.scenarios.filter((scenario) => !ids.includes(scenario.id));
        state.runs = state.runs.filter((run) => !ids.includes(run.scenario_id));
        return ids;
      });
      rmSync(target, { recursive: true, force: true });
      return { deleted_scenarios: deletedScenarioIds.length };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/projects/:project_id/scenarios/upload", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const part = await request.file();
    if (!part || !part.filename?.endsWith(".zip")) {
      return sendError(reply, 400, "Expected a zip file");
    }
    const state = store.readState();
    const project = findProject(state, project_id);
    if (!project) {
      return sendError(reply, 404, "Project not found", "project.not_found");
    }
    const buffer = await part.toBuffer();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-upload-"));
    try {
      const zip = new AdmZip(buffer);
      zip.extractAllTo(tempDir, true);
      const metadataPath = path.join(tempDir, "metadata.json");
      const scenarioPath = path.join(tempDir, SCENARIO_FILE_NAME);
      if (!existsSync(metadataPath)) {
        return sendError(reply, 400, "metadata.json not found in zip");
      }
      if (!existsSync(scenarioPath)) {
        return sendError(reply, 400, "scenario.spec.ts not found in zip");
      }
      const rawMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      rawMetadata.inputs = normalizeInputSpecs(rawMetadata.inputs);
      const parsedMetadata = ScenarioMetadataSchema.safeParse(rawMetadata);
      if (!parsedMetadata.success) {
        return sendError(reply, 400, "Invalid metadata.json");
      }
      const metadata = parsedMetadata.data;
      const env = state.environments.find((item) => item.id === metadata.env_id && item.project_id === project_id);
      if (!env) {
        return sendError(reply, 400, "Invalid env_id for project");
      }
      if (metadata.requires_auth) {
        const authRef = metadata.auth_state_ref;
        if (!authRef || !existsSync(path.join(tempDir, authRef))) {
          return sendError(reply, 400, "auth_state file not found in zip");
        }
      }
      const source = readFileSync(scenarioPath, "utf8");
      if (source.includes("http://localhost") || source.includes("https://localhost")) {
        return sendError(reply, 400, "localhost URLs are not allowed");
      }
      // Phase 4 (4.2) — server-attested owner. When the request is authenticated (PAT bearer or
      // session), trust the real uploader over the agent's client-claimed recorded_by string.
      const uploader = resolveRequestUser(request);
      if (uploader) {
        metadata.recorded_by = uploader.login;
      }
      const folderPath = normalizeFolderPath(
        (request.query as { path?: string }).path ?? metadata.folder_path ?? ""
      );

      // Phase 2 / 2-R4 — stable ULID id. Reconcile by the metadata anchor first (re-upload of the
      // same scenario keeps its id + storage dir even if the folder changed); otherwise mint a new
      // ULID and persist it back into the package so future re-uploads carry the anchor.
      const anchorUlid = isUlid(metadata.scenario_ulid) ? String(metadata.scenario_ulid).toUpperCase() : null;
      const existingByAnchor = anchorUlid
        ? state.scenarios.find((item) => item.id === anchorUlid && item.project_id === project_id) ?? null
        : null;
      const scenarioId = existingByAnchor?.id ?? anchorUlid ?? generateUlid();
      metadata.scenario_ulid = scenarioId;
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

      let scenarioDir: string;
      if (existingByAnchor) {
        scenarioDir = scenarioDirFromPackage(existingByAnchor.package_path);
      } else {
        const parentDir = folderDir(config.storage_dir, project_id, folderPath);
        scenarioDir = uniqueChildDir(parentDir, `${slugify(metadata.scenario_slug)}-${scenarioId.slice(0, 8)}`);
      }
      mkdirSync(scenarioDir, { recursive: true });
      const packagePath = existingByAnchor ? existingByAnchor.package_path : scenarioPackagePath(scenarioDir);
      writeZipFromDirectory(tempDir, packagePath);

      const scenario: ScenarioRecord = {
        id: scenarioId,
        project_id,
        env_id: metadata.env_id,
        name: metadata.scenario_name,
        slug: metadata.scenario_slug,
        folder_path: folderPath,
        created_by: metadata.recorded_by,
        created_at: metadata.recorded_at || new Date().toISOString(),
        package_path: packagePath,
        status: "active",
        inputs: metadata.inputs
      };
      let uploadedScenario = scenario;
      store.update((nextState) => {
        const existing = nextState.scenarios.find(
          (item) => item.id === scenarioId || path.resolve(item.package_path) === path.resolve(packagePath)
        );
        if (existing) {
          Object.assign(existing, {
            ...scenario,
            id: existing.id
          });
          uploadedScenario = existing;
          return;
        }
        nextState.scenarios.push(scenario);
      });
      if (uploader) {
        auditStore.record({
          action: "scenario.upload",
          actor_id: uploader.id,
          actor_login: uploader.login,
          target: uploadedScenario.id,
          meta: { project_id, scenario_name: metadata.scenario_name }
        });
      }
      return uploadedScenario;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  app.get("/api/scenarios/:scenario_id/download", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${path.basename(scenario.package_path)}"`);
    return readFileSync(scenario.package_path);
  });

  app.post("/api/scenarios/:scenario_id/move", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const body = ScenarioMoveBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "Invalid move payload");
    }
    const newFolderPath = normalizeFolderPath(body.data.path);
    const state = store.readState();
    const scenario = findScenario(state, scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    if (scenario.folder_path === newFolderPath) {
      return { moved: false, path: newFolderPath };
    }
    try {
      const destinationParent = folderDir(config.storage_dir, scenario.project_id, newFolderPath);
      const sourceDir = scenarioDirFromPackage(scenario.package_path);
      if (!existsSync(sourceDir)) {
        return sendError(reply, 404, "Scenario folder not found");
      }
      const destinationDir = uniqueChildDir(destinationParent, path.basename(sourceDir));
      mkdirSync(path.dirname(destinationDir), { recursive: true });
      renameSync(sourceDir, destinationDir);
      store.update((nextState) => {
        const target = nextState.scenarios.find((item) => item.id === scenario_id);
        if (!target) {
          return;
        }
        target.folder_path = newFolderPath;
        target.package_path = scenarioPackagePath(destinationDir);
        for (const run of nextState.runs) {
          if (run.scenario_id !== scenario_id) {
            continue;
          }
          run.artifacts_path = repath(sourceDir, destinationDir, run.artifacts_path) ?? run.artifacts_path;
          run.stdout_path = repath(sourceDir, destinationDir, run.stdout_path) ?? run.stdout_path;
          run.stderr_path = repath(sourceDir, destinationDir, run.stderr_path) ?? run.stderr_path;
        }
      });
      return { moved: true, path: newFolderPath };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/scenarios/:scenario_id", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const state = store.readState();
    const scenario = findScenario(state, scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    store.update((nextState) => {
      nextState.runs = nextState.runs.filter((run) => run.scenario_id !== scenario_id);
      nextState.scenarios = nextState.scenarios.filter((item) => item.id !== scenario_id);
    });
    rmSync(scenarioDirFromPackage(scenario.package_path), { recursive: true, force: true });
    return { deleted: true };
  });

  // RunWizard preview (Phase 3): resolve what {server_*} placeholders would become for the chosen
  // account/merchant/overrides, masking secrets. Lets the user verify the substitution before a run.
  app.post("/api/scenarios/:scenario_id/run/preview", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) {
      return;
    }
    const { scenario_id } = request.params as { scenario_id: string };
    const state = store.readState();
    const scenario = findScenario(state, scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    const body = (request.body ?? {}) as {
      account_login?: string;
      merchant_name?: string;
      server_username?: string;
      server_password?: string;
      server_2faotp?: string;
      server_merchant?: string;
    };
    try {
      const bindings = previewServerBindings(state, { project_id: scenario.project_id, ...body });
      // Pre-run config check: which {server_*} the scenario source references, and which of those
      // would resolve to nothing for the current project + selection (predicts the plan/run-time
      // "Set server ..." errors). Covers the four standard tokens; extra {server_*} not detected.
      let required: string[] = [];
      try {
        required = detectRequiredServerInputs(readScenarioSource(scenario.package_path));
      } catch {
        required = [];
      }
      const available: Record<string, boolean> = {
        server_username: Boolean(bindings.server_username),
        server_password: bindings.has_password,
        server_2faotp: bindings.has_2faotp,
        server_merchant: Boolean(bindings.server_merchant)
      };
      const missing = required.filter((name) => !available[name]);
      return { ...bindings, required_server_inputs: required, missing_server_inputs: missing };
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/scenarios/:scenario_id/run", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const body = RunCreateBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "Invalid run payload");
    }
    const state = store.readState();
    const scenario = findScenario(state, scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found", "scenario.not_found");
    }
    let plans: PreparedRunPlan[];
    try {
      plans = prepareRepeatedScenarioRunPlans(state, scenario, {
        env_id: body.data.env_id,
        account_login: body.data.account_login,
        merchant_name: body.data.merchant_name,
        server_username: body.data.server_username,
        server_password: body.data.server_password,
        server_2faotp: body.data.server_2faotp,
        server_merchant: body.data.server_merchant,
        inputs: body.data.inputs,
        pool_selections: body.data.pool_selections,
        ensure_right_address_to_run: body.data.ensure_right_address_to_run,
        ignore_variables: body.data.ignore_variables,
        ignored_inputs: body.data.ignored_inputs,
        amount_times_to_run: body.data.amount_times_to_run,
        parallel_batch_size: body.data.parallel_batch_size,
        default_timeout_ms: body.data.default_timeout_ms
      });
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    store.update((nextState) => {
      nextState.runs.push(...plans.map((plan) => plan.run));
    });
    enqueueFolderRunExecution(plans);
    return plans.length === 1 ? plans[0].run : { batch_id: plans[0]?.run.batch_id ?? null, runs: plans.map((plan) => plan.run) };
  });

  app.post("/api/projects/:project_id/folder-runs", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const body = FolderRunCreateBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "Invalid folder run payload");
    }
    const state = store.readState();
    const project = findProject(state, project_id);
    if (!project) {
      return sendError(reply, 404, "Project not found", "project.not_found");
    }

    let plans: PreparedRunPlan[];
    try {
      plans = prepareFolderRunPlans(
        state,
        project_id,
        body.data.folder_paths,
        body.data.scenario_inputs,
        body.data.scenario_execution,
        body.data.shared_inputs,
        {
          account_login: body.data.account_login,
          merchant_name: body.data.merchant_name,
          server_username: body.data.server_username,
          server_password: body.data.server_password,
          server_2faotp: body.data.server_2faotp,
          server_merchant: body.data.server_merchant,
          pool_selections: body.data.pool_selections,
          ensure_right_address_to_run: body.data.ensure_right_address_to_run,
          ignore_variables: body.data.ignore_variables,
          ignored_inputs: body.data.ignored_inputs
        },
        body.data.scenario_ids
      );
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    if (plans.length === 0) {
      return sendError(reply, 404, "No scenarios found in selected folders");
    }

    store.update((nextState) => {
      nextState.runs.push(...plans.map((plan) => plan.run));
    });
    enqueueFolderRunExecution(plans);

    return {
      folder_paths: body.data.folder_paths,
      scenario_ids: body.data.scenario_ids ?? null,
      scenario_count: plans.length,
      batch_id: plans[0]?.run.batch_id ?? null,
      account_login: body.data.account_login ?? null,
      merchant_name: body.data.merchant_name ?? null,
      server_username: plans[0]?.run.server_username ?? null,
      server_password: plans[0]?.run.server_password ?? null,
      server_2faotp: plans[0]?.run.server_2faotp ?? null,
      server_merchant: plans[0]?.run.server_merchant ?? null,
      shared_inputs: body.data.shared_inputs,
      runs: plans.map((plan) => plan.run)
    };
  });

  app.delete("/api/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    store.update((state) => {
      state.runs = state.runs.filter((item) => item.id !== run_id);
    });
    if (run.artifacts_path) {
      rmSync(run.artifacts_path, { recursive: true, force: true });
    }
    return { deleted: true };
  });

  app.get("/api/runs/:run_id/artifacts", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run || !run.artifacts_path) {
      return sendError(reply, 404, "Artifacts not found");
    }
    return { artifacts: listArtifacts(run.artifacts_path) };
  });

  // Extracted run outputs (outputs.json) — the values the scenario's declared outputs captured.
  app.get("/api/runs/:run_id/outputs", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found", "run.not_found");
    }
    return { outputs: readRunOutputs(run) };
  });

  app.get("/api/runs/:run_id/artifacts/*", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const artifactPath = (request.params as { "*": string })["*"];
    const run = findRun(store.readState(), run_id);
    if (!run || !run.artifacts_path) {
      return sendError(reply, 404, "Artifacts not found");
    }
    let target = "";
    try {
      target = safeJoin(run.artifacts_path, artifactPath);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      return sendError(reply, 404, "Artifact not found");
    }
    // Set a content type so media (video/screenshots) render inline in the browser instead of
    // downloading as octet-stream. Honour HTTP Range so the <video> player can seek (webm/mp4
    // seeking requires 206 Partial Content); without it the timeline scrubber does nothing.
    const total = statSync(target).size;
    reply.type(artifactContentType(target));
    reply.header("Accept-Ranges", "bytes");
    const rangeHeader = request.headers.range;
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
      if (Number.isNaN(start) || start > end || start >= total) {
        reply.code(416).header("Content-Range", `bytes */${total}`);
        return reply.send();
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(target, { start, end }));
    }
    reply.header("Content-Length", String(total));
    return reply.send(createReadStream(target));
  });

  app.get("/api/runs/:run_id/stdout", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run?.stdout_path || !existsSync(run.stdout_path)) {
      return sendError(reply, 404, "stdout not found");
    }
    reply.type("text/plain; charset=utf-8");
    return readTextLog(run.stdout_path, normalizeTextTailLimit((request.query as { tail?: string | number }).tail));
  });

  app.get("/api/runs/:run_id/stderr", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run?.stderr_path || !existsSync(run.stderr_path)) {
      return sendError(reply, 404, "stderr not found");
    }
    reply.type("text/plain; charset=utf-8");
    return readTextLog(run.stderr_path, normalizeTextTailLimit((request.query as { tail?: string | number }).tail));
  });

  return app;
}

// Phase 3 / 3.M8 — structured errors: { error, code }. The human message stays for back-compat and
// as a fallback; the client maps `code` to a localized string when present.
function sendError(reply: FastifyReply, statusCode: number, message: string, code?: string) {
  reply.code(statusCode);
  return reply.send({ error: message, code: code ?? null });
}

function findProject(state: AppState, projectId: string): ProjectRecord | undefined {
  return state.projects.find((project) => project.id === projectId);
}

function findScenario(state: AppState, scenarioId: string): ScenarioRecord | undefined {
  return state.scenarios.find((scenario) => scenario.id === scenarioId);
}

function findRun(state: AppState, runId: string): RunRecord | undefined {
  return state.runs.find((run) => run.id === runId);
}

function prepareRepeatedScenarioRunPlans(
  state: AppState,
  scenario: ScenarioRecord,
  options: NonNullable<Parameters<typeof prepareScenarioRunPlan>[2]> & {
    amount_times_to_run?: number;
    parallel_batch_size?: number;
  } = {}
): PreparedRunPlan[] {
  const amountTimesToRun = normalizePositiveInteger(options.amount_times_to_run) ?? 1;
  const parallelBatchSize = Math.min(normalizePositiveInteger(options.parallel_batch_size) ?? amountTimesToRun, amountTimesToRun);
  const batchId = amountTimesToRun > 1 ? (options.batch_id ?? randomUUID()) : (options.batch_id ?? null);
  const triggeredAt = options.triggered_at ?? new Date().toISOString();
  const baseStage = normalizePositiveInteger(options.execution_stage) ?? 1;
  const allocationContext = createSharedPoolAllocationContext();

  return Array.from({ length: amountTimesToRun }, (_value, index) =>
    prepareScenarioRunPlan(state, scenario, {
      ...options,
      batch_id: batchId,
      triggered_at: triggeredAt,
      pool_allocation_context: allocationContext,
      execution_stage: baseStage + Math.floor(index / parallelBatchSize),
      amount_times_to_run: amountTimesToRun,
      run_iteration: index + 1
    })
  );
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function createSharedPoolAllocationContext(): NonNullable<Parameters<typeof prepareScenarioRunPlan>[2]>["pool_allocation_context"] {
  return {
    selectedItemCounts: new Map<string, number>()
  };
}

type RetryRunBody = {
  inputs: Record<string, string>;
  server_username?: string;
  server_password?: string;
  server_2faotp?: string;
  server_merchant?: string;
  default_timeout_ms?: number | null;
  has_default_timeout_ms: boolean;
};

function normalizeRetryRunBody(value: unknown): RetryRunBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { inputs: {}, has_default_timeout_ms: false };
  }
  const body = value as Record<string, unknown>;
  const rawInputs = body.inputs;
  const inputs =
    rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)
      ? Object.fromEntries(
          Object.entries(rawInputs as Record<string, unknown>).map(([name, inputValue]) => [name, String(inputValue ?? "")])
        )
      : {};
  const normalized: RetryRunBody = { inputs, has_default_timeout_ms: false };
  for (const name of ["server_username", "server_password", "server_2faotp", "server_merchant"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      normalized[name] = String(body[name] ?? "");
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "default_timeout_ms")) {
    normalized.has_default_timeout_ms = true;
    const text = String(body.default_timeout_ms ?? "").trim();
    if (!text) {
      normalized.default_timeout_ms = null;
      return normalized;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 1) {
      normalized.default_timeout_ms = Math.trunc(parsed);
    }
  }
  return normalized;
}

function buildRetryInputs(
  run: RunRecord,
  scenario: ScenarioRecord,
  inputOverrides: Record<string, string> = {}
): Record<string, string> {
  const inputSpecs = new Map(scenario.inputs.map((spec) => [spec.name, spec]));
  const baseInputs = Object.fromEntries(
    Object.entries(run.inputs ?? {}).map(([name, value]) => {
      const spec = inputSpecs.get(name);
      if (spec?.type === "2fa_otp" && typeof value === "string" && value.startsWith("otp:")) {
        return [name, value.slice(4)];
      }
      return [name, String(value ?? "")];
    })
  );
  return {
    ...baseInputs,
    ...inputOverrides
  };
}

// Clone an existing batch member into a fresh run plan in the same batch (reuses its env, account,
// merchant, inputs, pools). Shared by batch retry-failed and top-up ("complete"). Returns null when
// the run can no longer be planned (missing scenario / removed pool) so the caller can skip it.
function buildBatchMemberPlan(
  state: AppState,
  source: RunRecord,
  batchId: string,
  overrides: { run_iteration?: number; amount_times_to_run?: number; triggered_by?: string } = {}
): PreparedRunPlan | null {
  const scenario = findScenario(state, source.scenario_id);
  if (!scenario) {
    return null;
  }
  try {
    return prepareScenarioRunPlan(state, scenario, {
      batch_id: batchId,
      env_id: source.env_id ?? scenario.env_id,
      account_login: source.account_login ?? undefined,
      merchant_name: source.merchant_name ?? undefined,
      server_username: source.server_username ?? undefined,
      server_password: source.server_password ?? undefined,
      server_2faotp: source.server_2faotp ?? undefined,
      server_merchant: source.server_merchant ?? undefined,
      inputs: buildRetryInputs(source, scenario),
      pool_selections: source.pool_selections ?? {},
      ignore_variables: source.ignore_variables,
      ignored_inputs: source.ignored_inputs,
      runtime_snapshot: source.runtime_snapshot ?? {},
      retry_of_run_id: source.id,
      execution_stage: source.execution_stage,
      amount_times_to_run: overrides.amount_times_to_run,
      run_iteration: overrides.run_iteration,
      default_timeout_ms: source.default_timeout_ms ?? undefined,
      triggered_by: overrides.triggered_by ?? "retry"
    });
  } catch {
    return null;
  }
}

function normalizeServerFieldValue(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalServerFieldValue(value: unknown): string | null {
  const text = normalizeServerFieldValue(value);
  return text || null;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeServerFieldValue).filter(Boolean);
  }
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function upsertPoolItem(
  state: AppState,
  poolId: string,
  itemId: string,
  value: string,
  data: {
    label?: string;
    enabled?: boolean;
    currency?: string;
    network?: string;
    metadata?: Record<string, unknown>;
    source?: PoolItemRecord["source"];
  },
  now: string
): PoolItemRecord {
  const pool = state.pools.find((item) => item.id === poolId);
  if (!pool) {
    throw new Error("Pool not found");
  }
  const normalizedValue = normalizeServerFieldValue(value);
  if (!normalizedValue) {
    throw new Error("Pool item value is required");
  }
  const duplicate = pool.dedupe
    ? state.pool_items.find((item) => item.pool_id === poolId && item.value === normalizedValue)
    : null;
  if (duplicate) {
    duplicate.label = data.label ?? duplicate.label;
    duplicate.enabled = data.enabled ?? duplicate.enabled;
    duplicate.currency = data.currency ?? duplicate.currency;
    duplicate.network = data.network ?? duplicate.network;
    duplicate.metadata = { ...duplicate.metadata, ...(data.metadata ?? {}) };
    duplicate.source = data.source ?? duplicate.source;
    duplicate.updated_at = now;
    return duplicate;
  }
  const existing = state.pool_items.find((item) => item.pool_id === poolId && item.id === itemId);
  const next: PoolItemRecord = {
    id: itemId,
    pool_id: poolId,
    value: normalizedValue,
    label: data.label ?? existing?.label ?? "",
    enabled: data.enabled ?? existing?.enabled ?? true,
    currency: data.currency ?? existing?.currency ?? "",
    network: data.network ?? existing?.network ?? "",
    metadata: data.metadata ?? existing?.metadata ?? {},
    source: data.source ?? existing?.source ?? { type: "manual" },
    created_at: existing?.created_at ?? now,
    updated_at: now,
    last_fetched_at: existing?.last_fetched_at ?? null,
    last_fetch_status: existing?.last_fetch_status ?? null
  };
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  state.pool_items.push(next);
  return next;
}

function readRunOutputs(run: RunRecord): Record<string, unknown> {
  if (!run.artifacts_path) {
    return {};
  }
  const outputsPath = path.join(run.artifacts_path, "outputs.json");
  if (!existsSync(outputsPath)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(outputsPath, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function extractOutputValues(
  value: unknown,
  options: {
    mode: "whole" | "array_items";
    jsonPath?: string;
  }
): string[] {
  const target = options.jsonPath ? extractJsonPathValues(value, options.jsonPath) : [value];
  const expanded = options.mode === "array_items" ? target.flatMap((item) => (Array.isArray(item) ? item : [item])) : target;
  return expanded.map(formatPoolValue).filter(Boolean);
}

function extractJsonPathValues(value: unknown, jsonPath: string): unknown[] {
  const normalized = String(jsonPath || "").trim();
  if (!normalized || normalized === "$") {
    return [value];
  }
  const tokens = normalized
    .replace(/^\$\./, "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown[] = [value];
  for (const token of tokens) {
    const isArrayToken = token.endsWith("[*]");
    const key = isArrayToken ? token.slice(0, -3) : token;
    const next: unknown[] = [];
    for (const item of current) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const child = (item as Record<string, unknown>)[key];
      if (isArrayToken && Array.isArray(child)) {
        next.push(...child);
      } else if (child !== undefined) {
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

function formatPoolValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value.trim() : JSON.stringify(value);
}

function normalizeAccountOtpValue(value: unknown): string {
  const text = normalizeServerFieldValue(value);
  if (!text) {
    return "";
  }
  try {
    return normalizeTotpSecret(text);
  } catch {
    throw new Error("Account 2FA OTP must be a valid base32 secret");
  }
}

function tryNormalizeTotpSecret(value: unknown): string {
  const text = normalizeOtpLogin(value);
  if (!text) {
    return "";
  }
  try {
    return normalizeTotpSecret(text);
  } catch {
    return "";
  }
}

function recoverInterruptedRuns(): void {
  store.update((state) => {
    for (const run of state.runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }
      const scenario = findScenario(state, run.scenario_id);
      const fallbackArtifactsPath = scenario
        ? runArtifactsDir(scenarioDirFromPackage(scenario.package_path), run.id)
        : null;
      const artifactsPath = run.artifacts_path ?? fallbackArtifactsPath;
      const stdoutPath = run.stdout_path ?? (artifactsPath ? path.join(artifactsPath, "stdout.log") : null);
      const stderrPath = run.stderr_path ?? (artifactsPath ? path.join(artifactsPath, "stderr.log") : null);

      run.artifacts_path = artifactsPath;
      run.stdout_path = stdoutPath;
      run.stderr_path = stderrPath;

      const resultPath = artifactsPath ? path.join(artifactsPath, "result.json") : null;
      if (resultPath && existsSync(resultPath)) {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
            status?: RunRecord["status"];
            finished_at?: string;
          };
          run.status = result.status ?? "error";
          run.finished_at = result.finished_at ?? run.finished_at ?? new Date().toISOString();
          run.summary_json = JSON.stringify(result);
          run.phase = "done";
          run.outcome = run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "error";
          continue;
        } catch {
          // Fall back to an interrupted run marker below.
        }
      }

      run.status = "error";
      run.finished_at = run.finished_at ?? new Date().toISOString();
      run.phase = "done";
      run.outcome = "interrupted";
      run.summary_json = JSON.stringify({
        status: "error",
        error: "Run was interrupted before completion. Please retry."
      });
      run.log_entries = appendRunLogEntry(run.log_entries, {
        timestamp: run.finished_at,
        level: "error",
        message: "Previous server session ended before this run completed. Marked as interrupted."
      });
    }
  });
}

function enqueueRunExecution(plan: PreparedRunPlan): void {
  queueMicrotask(async () => {
    await runSemaphore.run(() =>
      executeRunJob(plan.run.id, plan.scenario, plan.env, plan.inputs, plan.otp_secrets, plan.ignore_variables, plan.ignored_inputs)
    );
  });
}

function enqueueFolderRunExecution(plans: PreparedRunPlan[]): void {
  const stages = new Map<number, PreparedRunPlan[]>();
  for (const plan of plans) {
    const group = stages.get(plan.execution_stage) ?? [];
    group.push(plan);
    stages.set(plan.execution_stage, group);
  }
  const orderedStages = Array.from(stages.entries())
    .sort(([left], [right]) => left - right)
    .map(([, stagePlans]) => stagePlans);

  queueMicrotask(async () => {
    // Stages stay sequential (next stage waits for the previous); within a stage, runs go in
    // parallel but the shared semaphore caps how many containers execute at once (P0-T02).
    for (const stagePlans of orderedStages) {
      await Promise.all(
        stagePlans.map((plan) =>
          runSemaphore.run(() => executeRunJob(plan.run.id, plan.scenario, plan.env, plan.inputs, plan.otp_secrets, plan.ignore_variables, plan.ignored_inputs))
        )
      );
    }
  });
}

// Phase 3 (2-R11) — drive the live Timeline by recording sub-phase transitions and durations.
function applyPhaseTransition(run: RunRecord, phase: RunPhase, now: string): void {
  const activeTiming = run.phase_timings[run.phase];
  if (activeTiming && activeTiming.status === "active") {
    activeTiming.duration_ms = Math.max(0, Date.parse(now) - Date.parse(activeTiming.started_at));
    activeTiming.status = "done";
  }
  run.phase = phase;
  run.phase_timings[phase] = { started_at: now, duration_ms: null, status: "active" };
}

function recordRunPhase(runId: string, phase: RunPhase): void {
  const timings = store.update((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) {
      return null;
    }
    applyPhaseTransition(run, phase, new Date().toISOString());
    return run.phase_timings;
  });
  emitRunEvent(runId, "run.phase", { phase, phase_timings: timings ?? {} });
}

function outcomeFromResult(result: { status: string; summary_json?: string | null }): RunOutcome {
  if (result.status === "passed") {
    return "passed";
  }
  if (result.status === "failed") {
    return "failed";
  }
  try {
    const summary = result.summary_json ? (JSON.parse(result.summary_json) as { error?: string }) : null;
    if (summary?.error && /timed out/i.test(summary.error)) {
      return "timeout";
    }
  } catch {
    // fall through to generic error
  }
  return "error";
}

// Crash recovery (Phase 3 / 2-R3 foundation). On startup any run still marked queued/running is an
// orphan from a previous process — its container/worker is gone — so finalize it as interrupted
// instead of leaving it stuck forever. The user re-runs via Retry (otp_secrets are intentionally not
// persisted, so a safe automatic resume is not possible).
function reconcileOrphanedRuns(): void {
  const now = new Date().toISOString();
  const orphans: string[] = [];
  store.update((state) => {
    for (const run of state.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "error";
        run.outcome = "interrupted";
        run.finished_at = now;
        applyPhaseTransition(run, "done", now);
        orphans.push(run.id);
      }
    }
  });
  for (const id of orphans) {
    appendRunLog(id, "Run interrupted by a server restart. Re-run it to try again.", {
      level: "warning",
      timestamp: now
    });
  }
}

async function executeRunJob(
  runId: string,
  scenario: ScenarioRecord,
  env: EnvironmentRecord,
  inputs: Record<string, string>,
  otpSecrets: Record<string, string>,
  ignoreVariables: boolean,
  ignoredInputs: string[]
): Promise<void> {
  const scenarioDir = scenarioDirFromPackage(scenario.package_path);
  const artifactsDir = runArtifactsDir(scenarioDir, runId);
  const stdoutPath = path.join(artifactsDir, "stdout.log");
  const stderrPath = path.join(artifactsDir, "stderr.log");
  const onExecutionLog = (entry: RunExecutionLogEvent) => {
    appendRunLog(runId, entry.message, {
      timestamp: entry.timestamp,
      level: entry.level,
      artifactsPath: artifactsDir
    });
  };

  store.update((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (run) {
      run.status = "running";
      run.started_at = new Date().toISOString();
      run.artifacts_path = artifactsDir;
      run.stdout_path = stdoutPath;
      run.stderr_path = stderrPath;
    }
  });
  emitRunEvent(runId, "run.status", { status: "running", phase: "queued" });
  appendRunLog(runId, "Run started. Preparing Docker execution.", {
    artifactsPath: artifactsDir
  });

  activeRuns.set(runId, { container_name: runContainerName(runId), stopped: false });

  try {
    const metadata = readMetadataFromPackage(scenario.package_path);
    const result = await runScenarioInDocker({
      container_name: runContainerName(runId),
      scenario_zip: scenario.package_path,
      artifacts_dir: artifactsDir,
      base_url: metadata.run_base_url ?? env.base_url,
      browser: metadata.browser,
      headless: metadata.headless,
      locale: metadata.locale,
      timezone: metadata.timezone,
      viewport: `${metadata.viewport.width}x${metadata.viewport.height}`,
      inputs,
      otp_secrets: otpSecrets,
      ignore_variables: ignoreVariables,
      ignored_inputs: ignoredInputs,
      otp_autoreplace: config.otp_autoreplace,
      docker_image: config.docker_image ?? undefined,
      docker_shm_size: config.docker_shm_size,
      docker_ipc: config.docker_ipc,
      docker_network: config.docker_network,
      docker_add_hosts: config.docker_add_hosts,
      docker_cpus: config.docker_cpus,
      docker_memory: config.docker_memory,
      docker_pids_limit: config.docker_pids_limit,
      docker_cap_drop: config.docker_cap_drop,
      docker_no_new_privileges: config.docker_no_new_privileges,
      docker_workspace_transport: config.docker_workspace_transport,
      docker_runner_mode: config.docker_runner_mode,
      timeout_ms: config.run_timeout_ms,
      default_timeout_ms:
        store.readState().runs.find((item) => item.id === runId)?.default_timeout_ms ??
        config.playwright_default_timeout_ms ??
        undefined,
      on_log: onExecutionLog,
      on_phase: (phase) => recordRunPhase(runId, phase)
    });
    const stopped = activeRuns.get(runId)?.stopped ?? false;
    const finalStatus: RunStatus = stopped ? "error" : result.status;
    const finalOutcome: RunOutcome = stopped ? "stopped" : outcomeFromResult(result);
    store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) {
        return;
      }
      run.status = finalStatus;
      run.finished_at = new Date().toISOString();
      run.artifacts_path = result.artifacts_path;
      run.stdout_path = result.stdout_path;
      run.stderr_path = result.stderr_path;
      run.summary_json = result.summary_json;
      applyPhaseTransition(run, "done", run.finished_at);
      run.outcome = finalOutcome;
    });
    emitRunEvent(runId, "run.status", {
      status: finalStatus,
      outcome: finalOutcome,
      phase: "done"
    });
    appendRunLog(
      runId,
      stopped
        ? "Run stopped by user."
        : result.status === "passed"
          ? "Run completed successfully."
          : result.status === "failed"
            ? "Run completed, but Playwright reported test failures."
            : "Run completed with an execution error.",
      {
        level: result.status === "passed" ? "info" : "warning",
        artifactsPath: result.artifacts_path ?? artifactsDir
      }
    );
    if (!stopped && result.status === "passed") {
      applyPoolFetchResults(runId);
      applyPoolAutoImports(runId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stopped = activeRuns.get(runId)?.stopped ?? false;
    const finalOutcome: RunOutcome = stopped ? "stopped" : /timed out/i.test(message) ? "timeout" : "error";
    store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) {
        return;
      }
      run.status = "error";
      run.finished_at = new Date().toISOString();
      run.summary_json = JSON.stringify({ status: stopped ? "stopped" : "error", error: message });
      run.artifacts_path ??= artifactsDir;
      run.stdout_path ??= stdoutPath;
      run.stderr_path ??= stderrPath;
      applyPhaseTransition(run, "done", run.finished_at);
      run.outcome = finalOutcome;
    });
    emitRunEvent(runId, "run.status", {
      status: "error",
      outcome: finalOutcome,
      phase: "done"
    });
    appendRunLog(runId, stopped ? "Run stopped by user." : `Run failed before completion: ${message}`, {
      timestamp: new Date().toISOString(),
      level: stopped ? "warning" : "error",
      artifactsPath: artifactsDir
    });
  } finally {
    activeRuns.delete(runId);
  }
}

function listRecentRuns(
  state: AppState,
  limit?: number
): Array<{ run: RunRecord; scenario?: ScenarioRecord; trace_id?: string; output_summary?: string }> {
  const runs = state.runs.slice().sort(compareRunsByRecency);
  const limitedRuns = typeof limit === "number" ? runs.slice(0, limit) : runs;
  return limitedRuns.map((run) => {
    const outputs = run.status === "passed" ? readRunOutputs(run) : {};
    return {
      run,
      scenario: findScenario(state, run.scenario_id),
      trace_id: run.status === "passed" ? formatRecentRunTraceId(run) : "",
      output_summary: run.status === "passed" ? formatRecentRunOutputs(outputs) : ""
    };
  });
}

function formatRecentRunTraceId(run: RunRecord): string {
  const inputEntry = Object.entries(run.inputs ?? {}).find(([name]) => isTraceInputName(name));
  if (inputEntry) {
    return String(inputEntry[1] ?? "");
  }
  const pools = run.runtime_snapshot?.pools;
  if (pools && typeof pools === "object" && !Array.isArray(pools)) {
    for (const [name, value] of Object.entries(pools as Record<string, unknown>)) {
      if (!isTraceInputName(name) || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const traceValue = (value as Record<string, unknown>).value;
      if (traceValue !== undefined && traceValue !== null) {
        return String(traceValue);
      }
    }
  }
  return "";
}

function formatRecentRunOutputs(outputs: Record<string, unknown>): string {
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([key, value]) => `${key}: ${formatRecentRunOutputValue(value)}`).join("; ");
}

function formatRecentRunOutputValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function isTraceInputName(value: string): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized === "trace" || normalized === "traceid" || normalized === "traceidentifier";
}

function compareRunsByRecency(left: RunRecord, right: RunRecord): number {
  return (
    compareDatesDesc(left.finished_at, right.finished_at) ||
    compareDatesDesc(left.started_at, right.started_at) ||
    compareDatesDesc(left.triggered_at, right.triggered_at) ||
    right.id.localeCompare(left.id)
  );
}

function compareDatesDesc(left?: string | null, right?: string | null): number {
  return String(right ?? "").localeCompare(String(left ?? ""));
}

function normalizeRecentRunsLimit(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(200, Math.trunc(parsed));
}

function normalizeTextTailLimit(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(50_000, Math.trunc(parsed));
}

function readTextLog(filePath: string, tail: number | null): string {
  const text = readFileSync(filePath, "utf8");
  if (!tail || text.length <= tail) {
    return text;
  }
  return text.slice(-tail);
}

const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".zip": "application/zip"
};

function artifactContentType(filePath: string): string {
  return ARTIFACT_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function listArtifacts(rootDir: string): string[] {
  const results: string[] = [];
  walkArtifacts(rootDir, rootDir, results);
  return results.sort();
}

function walkArtifacts(rootDir: string, currentDir: string, results: string[]): void {
  for (const item of readdirSync(currentDir)) {
    const target = path.join(currentDir, item);
    const stat = statSync(target);
    if (stat.isDirectory()) {
      walkArtifacts(rootDir, target, results);
    } else if (stat.isFile()) {
      results.push(path.relative(rootDir, target).replaceAll("\\", "/"));
    }
  }
}

function repath(oldRoot: string, newRoot: string, value?: string | null): string | null | undefined {
  if (!value) {
    return value;
  }
  try {
    const relative = path.relative(path.resolve(oldRoot), path.resolve(value));
    if (relative.startsWith("..")) {
      return value;
    }
    return path.resolve(newRoot, relative);
  } catch {
    return value;
  }
}

function writeZipFromDirectory(sourceDir: string, targetZip: string): void {
  const zip = new AdmZip();
  for (const filePath of walkFiles(sourceDir)) {
    zip.addLocalFile(filePath, path.dirname(path.relative(sourceDir, filePath)).replaceAll("\\", "/"));
  }
  zip.writeZip(targetZip);
}

function walkFiles(rootDir: string): string[] {
  const files: string[] = [];
  for (const item of readdirSync(rootDir)) {
    const target = path.join(rootDir, item);
    const stat = statSync(target);
    if (stat.isDirectory()) {
      files.push(...walkFiles(target));
    } else if (stat.isFile()) {
      files.push(target);
    }
  }
  return files;
}

function readMetadataFromPackage(packagePath: string) {
  const zip = new AdmZip(packagePath);
  const entry = zip.getEntry("metadata.json");
  if (!entry) {
    throw new Error("metadata.json not found in package");
  }
  return ScenarioMetadataSchema.parse(JSON.parse(entry.getData().toString("utf8")));
}

function readScenarioSource(packagePath: string): string {
  const zip = new AdmZip(packagePath);
  const entry = zip.getEntry(SCENARIO_FILE_NAME);
  if (!entry) {
    throw new Error(`${SCENARIO_FILE_NAME} not found in package`);
  }
  return entry.getData().toString("utf8");
}

function appendRunLog(
  runId: string,
  message: string,
  options: {
    timestamp?: string;
    level?: RunLogLevel;
    artifactsPath?: string | null;
  } = {}
): void {
  const entry: RunLogEntry = {
    timestamp: options.timestamp ?? new Date().toISOString(),
    level: options.level ?? "info",
    message
  };

  store.update((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) {
      return;
    }
    run.log_entries = appendRunLogEntry(run.log_entries, entry);
  });
  emitRunEvent(runId, "run.log", entry);

  const executionLogPath = path.join(options.artifactsPath ?? "", "execution.log");
  if (options.artifactsPath) {
    appendFileSync(executionLogPath, formatRunLogEntry(entry), "utf8");
  }
}

function applyPoolFetchResults(runId: string): void {
  const state = store.readState();
  const run = findRun(state, runId);
  const fetchSnapshot = readPoolFetchSnapshot(run?.runtime_snapshot);
  if (!run || !fetchSnapshot) {
    return;
  }
  const outputs = readRunOutputs(run);
  const outputValue = outputs[fetchSnapshot.output_key];
  const updates = normalizeFetchResultUpdates(outputValue);
  const now = new Date().toISOString();

  store.update((nextState) => {
    for (const item of nextState.pool_items.filter((entry) => entry.pool_id === fetchSnapshot.pool_id)) {
      const update = updates.get(item.id) ?? updates.get(item.value);
      if (!update) {
        continue;
      }
      item.metadata = {
        ...item.metadata,
        ...update.metadata,
        fetch_result: update.raw
      };
      item.last_fetched_at = now;
      item.last_fetch_status = update.status || "passed";
      item.updated_at = now;
    }
  });
}

function applyPoolAutoImports(runId: string): void {
  const state = store.readState();
  const run = findRun(state, runId);
  if (!run || run.status !== "passed") {
    return;
  }
  const outputs = readRunOutputs(run);
  const pools = state.pools.filter(
    (pool) =>
      pool.auto_import_enabled &&
      pool.auto_import_output_key &&
      (!pool.auto_import_scenario_id || pool.auto_import_scenario_id === run.scenario_id) &&
      pool.auto_import_output_key in outputs
  );
  if (pools.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  store.update((nextState) => {
    for (const pool of pools) {
      const values = extractOutputValues(outputs[pool.auto_import_output_key], {
        mode: pool.auto_import_mode,
        jsonPath: pool.auto_import_json_path
      });
      for (const value of values) {
        upsertPoolItem(nextState, pool.id, `pool_item_${randomUUID()}`, value, {
          source: {
            type: "run_output",
            run_id: run.id,
            scenario_id: run.scenario_id,
            output_key: pool.auto_import_output_key
          }
        }, now);
      }
    }
  });
}

function readPoolFetchSnapshot(value: unknown): { pool_id: string; output_key: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const fetch = record.pool_fetch;
  if (!fetch || typeof fetch !== "object") {
    return null;
  }
  const fetchRecord = fetch as Record<string, unknown>;
  const poolId = normalizeServerFieldValue(fetchRecord.pool_id);
  const outputKey = normalizeServerFieldValue(fetchRecord.output_key);
  if (!poolId || !outputKey) {
    return null;
  }
  return { pool_id: poolId, output_key: outputKey };
}

function normalizeFetchResultUpdates(
  value: unknown
): Map<string, { status: string; metadata: Record<string, unknown>; raw: unknown }> {
  const updates = new Map<string, { status: string; metadata: Record<string, unknown>; raw: unknown }>();
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, item }))
      : [];

  for (const entry of entries) {
    const raw = Array.isArray(value) ? entry : (entry as { key: string; item: unknown }).item;
    const fallbackKey = Array.isArray(value) ? "" : (entry as { key: string }).key;
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = normalizeServerFieldValue(record.id) || fallbackKey;
    const itemValue = normalizeServerFieldValue(record.value) || normalizeServerFieldValue(record.address);
    const status = normalizeServerFieldValue(record.status) || "passed";
    const metadata =
      record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : record;
    if (id) {
      updates.set(id, { status, metadata, raw });
    }
    if (itemValue) {
      updates.set(itemValue, { status, metadata, raw });
    }
  }

  return updates;
}

function appendRunLogEntry(existing: RunRecord["log_entries"] | undefined, entry: RunLogEntry): RunLogEntry[] {
  const next = [...(existing ?? []), entry];
  return next.slice(-MAX_RUN_LOG_ENTRIES);
}

function formatRunLogEntry(entry: RunLogEntry): string {
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n`;
}
