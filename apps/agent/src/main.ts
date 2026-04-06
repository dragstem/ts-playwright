import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  buildScenarioMetadata,
  extractInputPlaceholders,
  filterInputSpecs,
  normalizeInputSpecs,
  slugify,
  type InputSpec,
  type OutputSpec,
  type ScenarioMetadata
} from "@ts-playwright/shared";
import { replayScenarioLocally, replaceBaseUrl } from "@ts-playwright/runner";

interface AgentConfig {
  server_url: string;
  api_key: string | null;
  default_user: string;
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
  return {
    server_url: String(data.server_url ?? "").replace(/\/+$/g, ""),
    api_key: data.api_key ?? null,
    default_user: data.default_user ?? "unknown"
  };
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

function headers(config: AgentConfig): Record<string, string> {
  return config.api_key ? { "X-API-KEY": config.api_key } : {};
}

ipcMain.handle("agent:get-config", async () => loadConfig());
ipcMain.handle("agent:get-runtime-state", async () => {
  syncStatus();
  return runtimeState;
});

ipcMain.handle("agent:start-recording", async (_event, payload: { start_url: string; save_auth_state: boolean }) => {
  if (recordingProcess && recordingProcess.exitCode === null) {
    recordingProcess.kill();
    recordingProcess = null;
  }
  const testPath = newScenarioPath("scenario", "spec.ts");
  const authStatePath = payload.save_auth_state ? newScenarioPath("auth_state", "json") : "";
  const args = ["codegen", payload.start_url, "--target", "playwright-test", "--output", testPath];
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
  });
  runtimeState = {
    status: "Recording",
    test_path: testPath,
    zip_path: "",
    auth_state_path: authStatePath,
    last_error: ""
  };
  return runtimeState;
});

ipcMain.handle("agent:stop-recording", async () => {
  if (recordingProcess && recordingProcess.exitCode === null) {
    recordingProcess.kill();
  }
  recordingProcess = null;
  runtimeState.status = "Idle";
  runtimeState.last_error = "";
  return runtimeState;
});

ipcMain.handle("agent:read-file", async (_event, payload: { path: string }) => {
  return readFileSync(payload.path, "utf8");
});

ipcMain.handle("agent:write-file", async (_event, payload: { path: string; content: string }) => {
  writeFileSync(payload.path, payload.content, "utf8");
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
      return result;
    } catch (error) {
      runtimeState.status = "Idle";
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
    try {
      let source = readFileSync(payload.source_path, "utf8");
      source = replaceBaseUrl(source, payload.recorded_base_url);
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
          headers: headers(config),
          body: form
        }
      );
      if (!response.ok) {
        throw new Error(await response.text());
      }
      runtimeState.status = "Idle";
      return {
        zip_path: zipPath,
        uploaded: await response.json()
      };
    } catch (error) {
      runtimeState.status = "Idle";
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
