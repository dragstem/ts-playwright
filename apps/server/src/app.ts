import { randomUUID } from "node:crypto";
import {
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
import Fastify, { type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import AdmZip from "adm-zip";
import {
  FolderCreateBodySchema,
  FolderMoveBodySchema,
  OtpAccountUpsertBodySchema,
  RunCreateBodySchema,
  ScenarioMetadataSchema,
  ScenarioMoveBodySchema,
  SCENARIO_FILE_NAME,
  type AppState,
  type EnvironmentRecord,
  type InputSpec,
  type OtpAccountRecord,
  type ProjectRecord,
  type RunRecord,
  type ScenarioRecord,
  folderDir,
  isScenarioDir,
  normalizeFolderPath,
  normalizeInputSpecs,
  normalizeOtpLogin,
  projectRootDir,
  runArtifactsDir,
  safeJoin,
  scenarioDirFromPackage,
  scenarioPackagePath,
  slugify,
  uniqueChildDir
} from "@ts-playwright/shared";
import { detectForeignDomains, runScenarioInDocker } from "@ts-playwright/runner";
import { loadConfig } from "./config";
import { renderCodePage, renderProjectPage, renderProjectsPage, renderRunPage, renderScenarioPage } from "./html";
import { JsonStateStore } from "./store";

const config = loadConfig();
const store = new JsonStateStore(config.state_file);

export function createServer() {
  const app = Fastify({ logger: true });
  app.register(multipart);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api")) {
      return;
    }
    if (!config.api_key) {
      return;
    }
    if (request.headers["x-api-key"] !== config.api_key) {
      return sendError(reply, 401, "Invalid API key");
    }
  });

  app.get("/", async () => renderProjectsPage(store.readState().projects));

  app.get("/projects/:project_id", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    const folderPath = normalizeFolderPath((request.query as { path?: string }).path ?? "");
    const state = store.readState();
    const project = findProject(state, project_id);
    if (!project) {
      return sendError(reply, 404, "Project not found");
    }
    let targetDir = "";
    try {
      targetDir = safeJoin(projectRootDir(config.storage_dir, project_id), folderPath);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      return sendError(reply, 404, "Folder not found");
    }
    if (isScenarioDir(targetDir)) {
      return sendError(reply, 400, "Path points to a scenario folder");
    }
    reply.type("text/html; charset=utf-8");
    return renderProjectPage({
      project,
      folder_path: folderPath,
      breadcrumbs: buildBreadcrumbs(folderPath),
      subfolders: listSubfolders(targetDir).map((name) => ({
        name,
        path: folderPath ? `${folderPath}/${name}` : name
      })),
      scenarios: state.scenarios.filter(
        (scenario) => scenario.project_id === project_id && normalizeFolderPath(scenario.folder_path) === folderPath
      )
    });
  });

  app.get("/scenarios/:scenario_id", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const state = store.readState();
    const scenario = findScenario(state, scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found");
    }
    reply.type("text/html; charset=utf-8");
    return renderScenarioPage({
      scenario,
      runs: state.runs
        .filter((run) => run.scenario_id === scenario_id)
        .sort((left, right) => (right.started_at ?? "").localeCompare(left.started_at ?? "")),
      otp_logins: state.otp_accounts.map((account) => account.login).sort()
    });
  });

  app.get("/scenarios/:scenario_id/code", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found");
    }
    let code = "scenario.spec.ts not found in package";
    try {
      const zip = new AdmZip(scenario.package_path);
      const entry = zip.getEntry(SCENARIO_FILE_NAME);
      if (entry) {
        code = entry.getData().toString("utf8");
      }
    } catch (error) {
      code = `Failed to read package: ${error instanceof Error ? error.message : String(error)}`;
    }
    reply.type("text/html; charset=utf-8");
    return renderCodePage(scenario, code);
  });

  app.get("/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const state = store.readState();
    const run = findRun(state, run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found");
    }
    const outputs =
      run.artifacts_path && existsSync(path.join(run.artifacts_path, "outputs.json"))
        ? JSON.parse(readFileSync(path.join(run.artifacts_path, "outputs.json"), "utf8"))
        : {};
    reply.type("text/html; charset=utf-8");
    return renderRunPage({
      run,
      scenario: findScenario(state, run.scenario_id),
      outputs
    });
  });

  app.get("/api/projects", async () => store.readState().projects);

  app.get("/api/projects/:project_id/environments", async (request) => {
    const { project_id } = request.params as { project_id: string };
    return store.readState().environments.filter((env) => env.project_id === project_id);
  });

  app.get("/api/projects/:project_id/scenarios", async (request) => {
    const { project_id } = request.params as { project_id: string };
    return store.readState().scenarios.filter((scenario) => scenario.project_id === project_id);
  });

  app.get("/api/scenarios/:scenario_id", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found");
    }
    return scenario;
  });

  app.get("/api/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found");
    }
    return run;
  });

  app.get("/api/otp-accounts", async () =>
    store.readState().otp_accounts
      .slice()
      .sort((left, right) => left.login.localeCompare(right.login))
      .map(({ secret: _secret, ...rest }) => rest)
  );

  app.post("/api/otp-accounts", async (request, reply) => {
    const body = OtpAccountUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, "OTP login and secret are required");
    }
    const login = normalizeOtpLogin(body.data.login);
    if (!login) {
      return sendError(reply, 400, "OTP login is required");
    }
    const now = new Date().toISOString();
    const account = store.update((state) => {
      const existing = state.otp_accounts.find((item) => item.login === login);
      if (existing) {
        existing.secret = body.data.secret.trim();
        existing.updated_at = now;
        return existing;
      }
      const created: OtpAccountRecord = {
        login,
        secret: body.data.secret.trim(),
        created_at: now,
        updated_at: now
      };
      state.otp_accounts.push(created);
      return created;
    });
    const { secret: _secret, ...result } = account;
    return result;
  });

  app.delete("/api/otp-accounts/:login", async (request, reply) => {
    const { login } = request.params as { login: string };
    const normalized = normalizeOtpLogin(login);
    if (!normalized) {
      return sendError(reply, 400, "OTP login is required");
    }
    const deleted = store.update((state) => {
      const index = state.otp_accounts.findIndex((item) => item.login === normalized);
      if (index < 0) {
        return false;
      }
      state.otp_accounts.splice(index, 1);
      return true;
    });
    if (!deleted) {
      return sendError(reply, 404, "OTP account not found");
    }
    return { deleted: true, login: normalized };
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
      return sendError(reply, 404, "Project not found");
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
      const foreignDomains = detectForeignDomains(source, metadata.run_base_url ?? env.base_url);
      if (foreignDomains.length > 0) {
        return sendError(reply, 400, `Foreign domains are not allowed: ${foreignDomains.join(", ")}`);
      }

      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
      const folderPath = normalizeFolderPath(
        (request.query as { path?: string }).path ?? metadata.folder_path ?? ""
      );
      const parentDir = folderDir(config.storage_dir, project_id, folderPath);
      const scenarioId = randomUUID();
      const scenarioDir = uniqueChildDir(parentDir, `${slugify(metadata.scenario_slug)}-${scenarioId.slice(0, 8)}`);
      mkdirSync(scenarioDir, { recursive: true });
      const packagePath = scenarioPackagePath(scenarioDir);
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
      store.update((nextState) => {
        nextState.scenarios.push(scenario);
      });
      return scenario;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  app.get("/api/scenarios/:scenario_id/download", async (request, reply) => {
    const { scenario_id } = request.params as { scenario_id: string };
    const scenario = findScenario(store.readState(), scenario_id);
    if (!scenario) {
      return sendError(reply, 404, "Scenario not found");
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
      return sendError(reply, 404, "Scenario not found");
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
      return sendError(reply, 404, "Scenario not found");
    }
    store.update((nextState) => {
      nextState.runs = nextState.runs.filter((run) => run.scenario_id !== scenario_id);
      nextState.scenarios = nextState.scenarios.filter((item) => item.id !== scenario_id);
    });
    rmSync(scenarioDirFromPackage(scenario.package_path), { recursive: true, force: true });
    return { deleted: true };
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
      return sendError(reply, 404, "Scenario not found");
    }
    const env = findEnvironment(state, body.data.env_id ?? scenario.env_id, scenario.project_id);
    if (!env) {
      return sendError(reply, 400, "Scenario environment not found");
    }
    const missing = scenario.inputs
      .filter((spec) => requiredInputMissing(spec, body.data.inputs))
      .map((spec) => spec.name);
    if (missing.length > 0) {
      return sendError(reply, 400, `Missing required inputs: ${missing.join(", ")}`);
    }
    let resolved: { inputs: Record<string, string>; stored: Record<string, string>; otp_secrets: Record<string, string> };
    try {
      resolved = resolveRunInputs(state, scenario.inputs, body.data.inputs);
    } catch (error) {
      return sendError(reply, 400, error instanceof Error ? error.message : String(error));
    }

    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      scenario_id,
      triggered_by: "api",
      triggered_at: new Date().toISOString(),
      status: "queued",
      started_at: null,
      finished_at: null,
      artifacts_path: null,
      stdout_path: null,
      stderr_path: null,
      summary_json: null,
      inputs: resolved.stored
    };
    store.update((nextState) => {
      nextState.runs.push(run);
    });

    queueMicrotask(async () => {
      await executeRunJob(runId, scenario, env, resolved.inputs, resolved.otp_secrets);
    });

    return run;
  });

  app.delete("/api/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run) {
      return sendError(reply, 404, "Run not found");
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
    return readFileSync(target);
  });

  app.get("/api/runs/:run_id/stdout", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run?.stdout_path || !existsSync(run.stdout_path)) {
      return sendError(reply, 404, "stdout not found");
    }
    reply.type("text/plain; charset=utf-8");
    return readFileSync(run.stdout_path, "utf8");
  });

  app.get("/api/runs/:run_id/stderr", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = findRun(store.readState(), run_id);
    if (!run?.stderr_path || !existsSync(run.stderr_path)) {
      return sendError(reply, 404, "stderr not found");
    }
    reply.type("text/plain; charset=utf-8");
    return readFileSync(run.stderr_path, "utf8");
  });

  return app;
}

function sendError(reply: FastifyReply, statusCode: number, message: string) {
  reply.code(statusCode).type("text/plain; charset=utf-8");
  return reply.send(message);
}

function findProject(state: AppState, projectId: string): ProjectRecord | undefined {
  return state.projects.find((project) => project.id === projectId);
}

function findEnvironment(state: AppState, envId: string, projectId: string): EnvironmentRecord | undefined {
  return state.environments.find((env) => env.id === envId && env.project_id === projectId);
}

function findScenario(state: AppState, scenarioId: string): ScenarioRecord | undefined {
  return state.scenarios.find((scenario) => scenario.id === scenarioId);
}

function findRun(state: AppState, runId: string): RunRecord | undefined {
  return state.runs.find((run) => run.id === runId);
}

async function executeRunJob(
  runId: string,
  scenario: ScenarioRecord,
  env: EnvironmentRecord,
  inputs: Record<string, string>,
  otpSecrets: Record<string, string>
): Promise<void> {
  store.update((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (run) {
      run.status = "running";
      run.started_at = new Date().toISOString();
    }
  });

  try {
    const scenarioDir = scenarioDirFromPackage(scenario.package_path);
    const artifactsDir = runArtifactsDir(scenarioDir, runId);
    const metadata = readMetadataFromPackage(scenario.package_path);
    const result = await runScenarioInDocker({
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
      otp_autoreplace: config.otp_autoreplace
    });
    store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) {
        return;
      }
      run.status = result.status;
      run.finished_at = new Date().toISOString();
      run.artifacts_path = result.artifacts_path;
      run.stdout_path = result.stdout_path;
      run.stderr_path = result.stderr_path;
      run.summary_json = result.summary_json;
    });
  } catch (error) {
    store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) {
        return;
      }
      run.status = "error";
      run.finished_at = new Date().toISOString();
      run.summary_json = JSON.stringify({ status: "error", error: String(error) });
    });
  }
}

function requiredInputMissing(spec: InputSpec, providedInputs: Record<string, string>): boolean {
  if (spec.type === "2fa_otp" && spec.otp_login) {
    return false;
  }
  return !String(providedInputs[spec.name] ?? "").trim();
}

function resolveRunInputs(
  state: AppState,
  scenarioInputs: InputSpec[],
  providedInputs: Record<string, string>
): { inputs: Record<string, string>; stored: Record<string, string>; otp_secrets: Record<string, string> } {
  const inputs: Record<string, string> = {};
  const stored: Record<string, string> = {};
  const otpSecrets: Record<string, string> = {};
  const knownNames = new Set(scenarioInputs.map((item) => item.name));

  for (const spec of scenarioInputs) {
    const rawValue = String(providedInputs[spec.name] ?? "");
    if (spec.type === "2fa_otp") {
      const login = normalizeOtpLogin(spec.otp_login || rawValue);
      if (!login) {
        if (spec.name in providedInputs) {
          stored[spec.name] = rawValue;
        }
        continue;
      }
      const account = state.otp_accounts.find((item) => item.login === login);
      if (!account) {
        throw new Error(`OTP account not found: ${login}`);
      }
      stored[spec.name] = `otp:${login}`;
      otpSecrets[spec.name] = account.secret;
      continue;
    }
    if (spec.name in providedInputs) {
      inputs[spec.name] = rawValue;
      stored[spec.name] = rawValue;
    }
  }

  for (const [name, value] of Object.entries(providedInputs)) {
    if (knownNames.has(name)) {
      continue;
    }
    inputs[name] = String(value ?? "");
    stored[name] = String(value ?? "");
  }

  return { inputs, stored, otp_secrets: otpSecrets };
}

function buildBreadcrumbs(folderPath: string): { name: string; path: string }[] {
  if (!folderPath) {
    return [];
  }
  const parts = folderPath.split("/");
  let acc = "";
  return parts.map((part) => {
    acc = acc ? `${acc}/${part}` : part;
    return { name: part, path: acc };
  });
}

function listSubfolders(folderPath: string): string[] {
  if (!existsSync(folderPath)) {
    return [];
  }
  return readdirSync(folderPath)
    .filter((name) => {
      const target = path.join(folderPath, name);
      return statSync(target).isDirectory() && !isScenarioDir(target);
    })
    .sort((left, right) => left.localeCompare(right));
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
