import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  DEFAULT_BROWSER,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_VIEWPORT,
  buildScenarioMetadata,
  extractInputPlaceholders,
  filterInputSpecs,
  normalizeInputSpecs,
  slugify,
  type InputSpec,
  type OutputSpec,
  type ScenarioMetadata
} from "@ts-playwright/shared";
import { forceExactOptionNameMatches, replayScenarioLocally, replaceBaseUrl } from "@ts-playwright/runner";
import { assertInsideDir } from "./path-guard";

interface AgentConfig {
  server_url: string;
  api_key: string | null;
  token: string | null;
  default_user: string;
}

interface AgentSettings {
  server_url?: string;
}

interface RuntimeState {
  status: "Idle" | "Recording" | "Replaying" | "Uploading";
  test_path: string;
  zip_path: string;
  auth_state_path: string;
  last_error: string;
}

const tempDir = path.join(os.tmpdir(), "ts-playwright-agent");
mkdirSync(tempDir, { recursive: true });

let mainWindow: BrowserWindow | null = null;
let recordingProcess: ReturnType<typeof spawn> | null = null;
let runtimeState: RuntimeState = {
  status: "Idle",
  test_path: "",
  zip_path: "",
  auth_state_path: "",
  last_error: ""
};

// Push the current runtime snapshot to the renderer (Phase 4 / 4.5) so status updates are real-time
// instead of polled once a second.
function emitRuntime(): void {
  mainWindow?.webContents.send("agent:runtime", runtimeState);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });
  void mainWindow.loadFile(path.join(__dirname, "assets", "index.html"));
}

function resolveConfigPath(): string {
  const candidates = [
    path.join(path.dirname(app.getPath("exe")), "config.json"),
    path.join(path.dirname(app.getPath("exe")), "config.example.json"),
    path.join(__dirname, "assets", "config.json"),
    path.join(__dirname, "assets", "config.example.json")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("agent config.json/config.example.json not found");
}

function loadConfig(): AgentConfig {
  const data = JSON.parse(readFileSync(resolveConfigPath(), "utf8"));
  const settings = loadSettings();
  return {
    server_url: settings.server_url ?? String(data.server_url ?? "").replace(/\/+$/g, ""),
    api_key: data.api_key ?? null,
    token: data.token ?? null,
    default_user: data.default_user ?? "unknown"
  };
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "agent-settings.json");
}

function loadSettings(): AgentSettings {
  try {
    const value = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as AgentSettings;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function normalizeServerUrl(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\/+$/g, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Server URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Server URL must not contain credentials, query parameters, or a fragment");
  }
  return parsed.toString().replace(/\/+$/g, "");
}

function storeServerUrl(value: unknown): string {
  const serverUrl = normalizeServerUrl(value);
  writeFileSync(settingsFilePath(), `${JSON.stringify({ server_url: serverUrl }, null, 2)}\n`, { mode: 0o600 });
  return serverUrl;
}

// Personal access token storage (Phase 4 / 4.1). The PAT is kept in the user-data dir, encrypted
// with the OS keychain via Electron safeStorage when available (plaintext fallback otherwise, with
// 0600-ish intent). It never reaches the renderer — server calls fetch the auth header over IPC.
function tokenFilePath(): string {
  return path.join(app.getPath("userData"), "agent-token.bin");
}

function loadStoredToken(): string | null {
  try {
    const filePath = tokenFilePath();
    if (!existsSync(filePath)) {
      return null;
    }
    const buffer = readFileSync(filePath);
    if (buffer.length === 0) {
      return null;
    }
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buffer).trim() || null;
    }
    return buffer.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

function storeToken(rawToken: string): void {
  const filePath = tokenFilePath();
  const token = rawToken.trim();
  if (!token) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return;
  }
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, "utf8");
  writeFileSync(filePath, data);
}

function playwrightCliPath(): string {
  return require.resolve("@playwright/test/cli");
}

function spawnPlaywright(args: string[]) {
  const env = { ...process.env };
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return spawn(process.execPath, [playwrightCliPath(), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env
  });
}

function newScenarioPath(prefix: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(tempDir, `${prefix}_${stamp}.${extension}`);
}

function syncStatus() {
  if (recordingProcess && recordingProcess.exitCode === null) {
    runtimeState.status = "Recording";
    return;
  }
  if (runtimeState.status === "Recording") {
    runtimeState.status = "Idle";
  }
}

// Auth header for every server call: a stored PAT (Bearer) takes precedence, then a config-file
// token, then the legacy machine API key. The new server enforces auth on all /api routes (RBAC),
// and the PAT also stamps owner_id on uploaded scenarios.
function authHeaders(config: AgentConfig): Record<string, string> {
  const token = loadStoredToken() ?? config.token;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (config.api_key) {
    return { "X-API-KEY": config.api_key };
  }
  return {};
}

ipcMain.handle("agent:get-config", async () => loadConfig());
ipcMain.handle("agent:set-server-url", async (_event, payload: { server_url: string }) => ({
  server_url: storeServerUrl(payload?.server_url)
}));
ipcMain.handle("agent:get-runtime-state", async () => {
  syncStatus();
  return runtimeState;
});

// Auth header for the renderer's server calls — keeps the raw PAT in the main process only.
ipcMain.handle("agent:get-auth-header", async () => authHeaders(loadConfig()));

ipcMain.handle("agent:set-token", async (_event, payload: { token: string }) => {
  storeToken(String(payload?.token ?? ""));
  return { ok: true, has_token: Boolean(loadStoredToken()) };
});

// Who am I? Resolves the stored credential against the server so the UI can show the signed-in user.
ipcMain.handle("agent:get-auth-status", async () => {
  const config = loadConfig();
  const header = authHeaders(config);
  const hasAuth = Object.keys(header).length > 0;
  let user: { login: string; role: string } | null = null;
  let reachable = false;
  if (hasAuth) {
    try {
      const response = await fetch(`${config.server_url}/api/auth/me`, { headers: header });
      reachable = true;
      if (response.ok) {
        user = (await response.json()) as { login: string; role: string };
      }
    } catch {
      reachable = false;
    }
  }
  return {
    server_url: config.server_url,
    has_token: Boolean(loadStoredToken()),
    api_key_set: Boolean(config.api_key),
    encryption_available: safeStorage.isEncryptionAvailable(),
    reachable,
    user
  };
});
ipcMain.handle("agent:clipboard-read-text", async () => clipboard.readText());
ipcMain.handle("agent:clipboard-write-text", async (_event, payload: { text: string }) => {
  clipboard.writeText(String(payload.text ?? ""));
  return { ok: true };
});

ipcMain.handle("agent:start-recording", async (_event, payload: { start_url: string; save_auth_state: boolean }) => {
  if (recordingProcess && recordingProcess.exitCode === null) {
    recordingProcess.kill();
    recordingProcess = null;
  }
  const testPath = newScenarioPath("scenario", "spec.ts");
  const authStatePath = payload.save_auth_state ? newScenarioPath("auth_state", "json") : "";
  const args = [
    "codegen",
    payload.start_url,
    "--target",
    "playwright-test",
    "--test-id-attribute",
    "id",
    "--output",
    testPath,
    "--browser",
    DEFAULT_BROWSER,
    "--viewport-size",
    `${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "--lang",
    DEFAULT_LOCALE,
    "--timezone",
    DEFAULT_TIMEZONE,
    "--timeout",
    "60000"
  ];
  if (authStatePath) {
    args.push("--save-storage", authStatePath);
  }
  recordingProcess = spawnPlaywright(args);
  let stderr = "";
  let stdout = "";
  recordingProcess.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  recordingProcess.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  recordingProcess.once("error", (error) => {
    runtimeState.last_error = error instanceof Error ? error.message : String(error);
    runtimeState.status = "Idle";
    recordingProcess = null;
    emitRuntime();
  });
  recordingProcess.once("close", () => {
    const hasRecordedFile = existsSync(testPath);
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    runtimeState.last_error =
      hasRecordedFile || !details
        ? hasRecordedFile
          ? ""
          : "Recording exited before a scenario file was created."
        : details;
    recordingProcess = null;
    runtimeState.status = "Idle";
    emitRuntime();
  });
  runtimeState = {
    status: "Recording",
    test_path: testPath,
    zip_path: "",
    auth_state_path: authStatePath,
    last_error: ""
  };
  emitRuntime();
  return runtimeState;
});

ipcMain.handle("agent:stop-recording", async () => {
  if (recordingProcess && recordingProcess.exitCode === null) {
    recordingProcess.kill();
  }
  recordingProcess = null;
  runtimeState.status = "Idle";
  runtimeState.last_error = "";
  emitRuntime();
  return runtimeState;
});

ipcMain.handle("agent:read-file", async (_event, payload: { path: string }) => {
  return readFileSync(assertInsideDir(payload.path, tempDir), "utf8");
});

ipcMain.handle("agent:write-file", async (_event, payload: { path: string; content: string }) => {
  writeFileSync(assertInsideDir(payload.path, tempDir), payload.content, "utf8");
  return { saved: true };
});

ipcMain.handle(
  "agent:replay",
  async (
    _event,
    payload: {
      source_path: string;
      metadata: ScenarioMetadata;
      auth_state_path?: string | null;
    }
  ) => {
    runtimeState.status = "Replaying";
    emitRuntime();
    try {
      const artifactsDir = path.join(tempDir, `replay_${Date.now()}`);
      mkdirSync(artifactsDir, { recursive: true });
      const result = await replayScenarioLocally({
        source_path: payload.source_path,
        metadata: payload.metadata,
        artifacts_dir: artifactsDir,
        base_url: payload.metadata.run_base_url ?? payload.metadata.recorded_base_url,
        auth_state_path: payload.auth_state_path ?? null
      });
      runtimeState.status = "Idle";
      emitRuntime();
      return result;
    } catch (error) {
      runtimeState.status = "Idle";
      emitRuntime();
      throw error;
    }
  }
);

ipcMain.handle(
  "agent:upload",
  async (
    _event,
    payload: {
      source_path: string;
      project_id: string;
      env_id: string;
      folder_path: string;
      scenario_name: string;
      recorded_base_url: string;
      outputs: OutputSpec[];
      inputs: InputSpec[];
      auth_state_path?: string | null;
    }
  ) => {
    const config = loadConfig();
    runtimeState.status = "Uploading";
    emitRuntime();
    try {
      let source = readFileSync(payload.source_path, "utf8");
      source = replaceBaseUrl(source, payload.recorded_base_url);
      source = forceExactOptionNameMatches(source);
      writeFileSync(payload.source_path, source, "utf8");

      const usedInputs = filterInputSpecs(normalizeInputSpecs(payload.inputs), extractInputPlaceholders(source));
      const scenarioSlug = slugify(payload.scenario_name);
      const authStatePath = payload.auth_state_path && existsSync(payload.auth_state_path) ? payload.auth_state_path : null;
      const metadata = buildScenarioMetadata({
        project_id: payload.project_id,
        env_id: payload.env_id,
        folder_path: payload.folder_path,
        scenario_name: payload.scenario_name,
        scenario_slug: scenarioSlug,
        recorded_by: config.default_user,
        recorded_base_url: payload.recorded_base_url,
        run_base_url: payload.recorded_base_url,
        outputs: payload.outputs,
        inputs: usedInputs,
        requires_auth: Boolean(authStatePath),
        auth_state_ref: authStatePath ? path.basename(authStatePath) : null
      });

      const zipPath = path.join(tempDir, `scenario_${payload.project_id}_${scenarioSlug}.zip`);
      const zip = new AdmZip();
      zip.addFile("scenario.spec.ts", Buffer.from(source, "utf8"));
      zip.addFile("metadata.json", Buffer.from(JSON.stringify(metadata, null, 2), "utf8"));
      if (authStatePath) {
        zip.addLocalFile(authStatePath, "", path.basename(authStatePath));
      }
      zip.writeZip(zipPath);
      runtimeState.zip_path = zipPath;

      const form = new FormData();
      form.set("file", new Blob([readFileSync(zipPath)]), path.basename(zipPath));
      const response = await fetch(
        `${config.server_url}/api/projects/${encodeURIComponent(payload.project_id)}/scenarios/upload${
          payload.folder_path ? `?path=${encodeURIComponent(payload.folder_path)}` : ""
        }`,
        {
          method: "POST",
          headers: authHeaders(config),
          body: form
        }
      );
      if (!response.ok) {
        throw new Error(await response.text());
      }
      runtimeState.status = "Idle";
      emitRuntime();
      return {
        zip_path: zipPath,
        uploaded: await response.json()
      };
    } catch (error) {
      runtimeState.status = "Idle";
      emitRuntime();
      throw error;
    }
  }
);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
