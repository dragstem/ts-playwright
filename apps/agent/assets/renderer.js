const state = {
  config: null,
  runtime: null,
  projects: [],
  envs: [],
  outputs: [],
  inputs: [],
  otpAccounts: [],
  selectedOutput: -1,
  selectedInput: -1,
  selectedOtp: -1,
  dirty: false,
  lastErrorSeen: ""
};

const elements = {
  projectSelect: document.getElementById("project-select"),
  envSelect: document.getElementById("env-select"),
  scenarioName: document.getElementById("scenario-name"),
  folderPath: document.getElementById("folder-path"),
  startUrl: document.getElementById("start-url"),
  saveAuth: document.getElementById("save-auth"),
  runtimeStatus: document.getElementById("runtime-status"),
  currentFile: document.getElementById("current-file"),
  preparedZip: document.getElementById("prepared-zip"),
  editor: document.getElementById("editor"),
  editorDirty: document.getElementById("editor-dirty"),
  outputKey: document.getElementById("output-key"),
  outputSelector: document.getElementById("output-selector"),
  outputMode: document.getElementById("output-mode"),
  outputAttr: document.getElementById("output-attr"),
  outputFrame: document.getElementById("output-frame"),
  outputTimeout: document.getElementById("output-timeout"),
  outputTableBody: document.querySelector("#output-table tbody"),
  inputType: document.getElementById("input-type"),
  inputName: document.getElementById("input-name"),
  inputDescription: document.getElementById("input-description"),
  inputAccount: document.getElementById("input-account"),
  inputTableBody: document.querySelector("#input-table tbody"),
  otpLogin: document.getElementById("otp-login"),
  otpSecret: document.getElementById("otp-secret"),
  otpTableBody: document.querySelector("#otp-table tbody"),
  refreshBtn: document.getElementById("refresh-btn"),
  recordBtn: document.getElementById("record-btn"),
  stopBtn: document.getElementById("stop-btn"),
  previewBtn: document.getElementById("preview-btn"),
  applyBtn: document.getElementById("apply-btn"),
  replayBtn: document.getElementById("replay-btn"),
  uploadBtn: document.getElementById("upload-btn"),
  addOutputBtn: document.getElementById("add-output-btn"),
  removeOutputBtn: document.getElementById("remove-output-btn"),
  addInputBtn: document.getElementById("add-input-btn"),
  removeInputBtn: document.getElementById("remove-input-btn"),
  insertInputBtn: document.getElementById("insert-input-btn"),
  insertOtpBtn: document.getElementById("insert-otp-btn"),
  otpRefreshBtn: document.getElementById("otp-refresh-btn"),
  otpSaveBtn: document.getElementById("otp-save-btn"),
  otpDeleteBtn: document.getElementById("otp-delete-btn")
};

window.addEventListener("DOMContentLoaded", async () => {
  state.config = await window.agent.getConfig();
  bindEvents();
  await refreshAll();
  await refreshRuntime();
  setInterval(refreshRuntime, 1000);
});

function bindEvents() {
  elements.projectSelect.addEventListener("change", refreshEnvs);
  elements.inputType.addEventListener("change", refreshInputAccountState);
  elements.refreshBtn.addEventListener("click", refreshAll);
  elements.recordBtn.addEventListener("click", startRecording);
  elements.stopBtn.addEventListener("click", stopRecording);
  elements.previewBtn.addEventListener("click", previewScenario);
  elements.applyBtn.addEventListener("click", saveEdits);
  elements.replayBtn.addEventListener("click", replayScenario);
  elements.uploadBtn.addEventListener("click", uploadScenario);
  elements.addOutputBtn.addEventListener("click", addOutput);
  elements.removeOutputBtn.addEventListener("click", removeOutput);
  elements.addInputBtn.addEventListener("click", addInput);
  elements.removeInputBtn.addEventListener("click", removeInput);
  elements.insertInputBtn.addEventListener("click", insertPlaceholderFromForm);
  elements.insertOtpBtn.addEventListener("click", insertOtpPlaceholder);
  elements.otpRefreshBtn.addEventListener("click", refreshOtpAccounts);
  elements.otpSaveBtn.addEventListener("click", saveOtpAccount);
  elements.otpDeleteBtn.addEventListener("click", deleteOtpAccount);
  elements.editor.addEventListener("input", () => setDirty(true));
}

async function refreshAll() {
  await Promise.all([refreshProjects(), refreshOtpAccounts()]);
  renderOutputs();
  renderInputs();
  refreshInputAccountState();
}

async function refreshProjects() {
  const projects = await apiJson("/api/projects");
  state.projects = Array.isArray(projects) ? projects : [];
  const selected = elements.projectSelect.value || state.projects[0]?.id || "";
  elements.projectSelect.innerHTML = state.projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.id)}</option>`)
    .join("");
  elements.projectSelect.value = state.projects.some((item) => item.id === selected) ? selected : state.projects[0]?.id || "";
  await refreshEnvs();
}

async function refreshEnvs() {
  const projectId = elements.projectSelect.value;
  if (!projectId) {
    state.envs = [];
    elements.envSelect.innerHTML = "";
    return;
  }
  const envs = await apiJson(`/api/projects/${encodeURIComponent(projectId)}/environments`);
  state.envs = Array.isArray(envs) ? envs : [];
  const selected = elements.envSelect.value || state.envs[0]?.id || "";
  elements.envSelect.innerHTML = state.envs
    .map((env) => `<option value="${escapeHtml(env.id)}">${escapeHtml(env.id)}</option>`)
    .join("");
  elements.envSelect.value = state.envs.some((item) => item.id === selected) ? selected : state.envs[0]?.id || "";
  if (!elements.startUrl.value && currentEnv()) {
    elements.startUrl.value = currentEnv().base_url || "";
  }
}

async function refreshOtpAccounts() {
  const accounts = await apiJson("/api/otp-accounts");
  state.otpAccounts = Array.isArray(accounts) ? accounts : [];
  renderOtpAccounts();
  refreshInputAccountOptions();
}

async function refreshRuntime() {
  state.runtime = await window.agent.getRuntimeState();
  elements.runtimeStatus.textContent = state.runtime.status;
  elements.currentFile.textContent = state.runtime.test_path || "-";
  elements.preparedZip.textContent = state.runtime.zip_path || "-";
  if (state.runtime.last_error && state.runtime.last_error !== state.lastErrorSeen) {
    state.lastErrorSeen = state.runtime.last_error;
    alert(state.runtime.last_error);
  }
  updateButtons();
}

function currentEnv() {
  return state.envs.find((env) => env.id === elements.envSelect.value) || null;
}

function updateButtons() {
  const hasFile = Boolean(state.runtime?.test_path);
  const recording = state.runtime?.status === "Recording";
  const busy = state.runtime && state.runtime.status !== "Idle";
  elements.recordBtn.disabled = recording;
  elements.stopBtn.disabled = !recording;
  elements.previewBtn.disabled = !hasFile;
  elements.applyBtn.disabled = !state.dirty || !hasFile;
  elements.replayBtn.disabled = !hasFile || recording;
  elements.uploadBtn.disabled = !hasFile || busy;
}

async function startRecording() {
  const startUrl = resolveStartUrl();
  if (!startUrl) {
    alert("Start URL is required.");
    return;
  }
  state.runtime = await window.agent.startRecording({
    start_url: startUrl,
    save_auth_state: elements.saveAuth.checked
  });
  elements.editor.value = "";
  setDirty(false);
  await refreshRuntime();
}

async function stopRecording() {
  state.runtime = await window.agent.stopRecording();
  await refreshRuntime();
}

async function previewScenario() {
  if (!state.runtime?.test_path) {
    alert("No test file recorded yet.");
    return;
  }
  const content = await window.agent.readFile({ path: state.runtime.test_path });
  elements.editor.value = content;
  syncInputsFromText(content);
  setDirty(false);
}

async function saveEdits() {
  if (!state.runtime?.test_path) {
    return;
  }
  await window.agent.writeFile({
    path: state.runtime.test_path,
    content: elements.editor.value
  });
  syncInputsFromText(elements.editor.value);
  setDirty(false);
}

async function replayScenario() {
  if (!state.runtime?.test_path) {
    alert("No test file recorded yet.");
    return;
  }
  if (state.dirty) {
    await saveEdits();
  }
  const result = await window.agent.replay({
    source_path: state.runtime.test_path,
    metadata: buildMetadataForReplay(),
    auth_state_path: state.runtime.auth_state_path || null
  });
  alert(`Replay finished with status: ${result.status}`);
  await refreshRuntime();
}

async function uploadScenario() {
  if (!state.runtime?.test_path) {
    alert("No test file recorded yet.");
    return;
  }
  if (state.dirty) {
    await saveEdits();
  }
  if (elements.saveAuth.checked && !state.runtime.auth_state_path) {
    alert("Auth state was not saved. Record again with 'Save auth state' enabled.");
    return;
  }
  const response = await window.agent.upload({
    source_path: state.runtime.test_path,
    project_id: elements.projectSelect.value,
    env_id: elements.envSelect.value,
    folder_path: normalizeFolderPath(elements.folderPath.value),
    scenario_name: elements.scenarioName.value.trim() || "New Scenario",
    recorded_base_url: resolveStartUrl(),
    outputs: state.outputs,
    inputs: state.inputs,
    auth_state_path: state.runtime.auth_state_path || null
  });
  await refreshRuntime();
  alert(`Scenario uploaded: ${response.uploaded.id}`);
}

function addOutput() {
  const key = elements.outputKey.value.trim();
  const selector = elements.outputSelector.value.trim();
  const mode = elements.outputMode.value.trim();
  const attr = elements.outputAttr.value.trim();
  const frame = elements.outputFrame.value.trim();
  const timeout = elements.outputTimeout.value.trim();
  if (!key || !selector) {
    alert("Key and selector are required.");
    return;
  }
  if (mode === "attr" && !attr) {
    alert("Attr is required for attr mode.");
    return;
  }
  const spec = { key, selector, mode };
  if (attr) spec.attr = attr;
  if (frame) spec.frame = frame;
  if (timeout) spec.timeout_ms = Number(timeout);
  state.outputs.push(spec);
  elements.outputKey.value = "";
  elements.outputSelector.value = "";
  elements.outputAttr.value = "";
  elements.outputFrame.value = "";
  elements.outputTimeout.value = "";
  renderOutputs();
}

function removeOutput() {
  if (state.selectedOutput < 0) return;
  state.outputs.splice(state.selectedOutput, 1);
  state.selectedOutput = -1;
  renderOutputs();
}

function renderOutputs() {
  elements.outputTableBody.innerHTML = state.outputs
    .map(
      (item, index) => `
        <tr data-index="${index}" class="${index === state.selectedOutput ? "selected" : ""}">
          <td><input type="radio" name="output-select" ${index === state.selectedOutput ? "checked" : ""} /></td>
          <td>${escapeHtml(item.key)}</td>
          <td>${escapeHtml(item.selector)}</td>
          <td>${escapeHtml(item.mode)}</td>
          <td>${escapeHtml(item.attr || "")}</td>
          <td>${escapeHtml(item.frame || "")}</td>
          <td>${escapeHtml(String(item.timeout_ms || ""))}</td>
        </tr>
      `
    )
    .join("");
  elements.outputTableBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedOutput = Number(row.dataset.index);
      renderOutputs();
    });
  });
}

function addInput() {
  const inputType = elements.inputType.value;
  const name = normalizeInputName(elements.inputName.value);
  if (!name) {
    alert("Name must contain only letters, digits, or underscores.");
    return;
  }
  if (state.inputs.some((item) => item.name === name)) {
    alert(`Variable '${name}' already exists.`);
    return;
  }
  state.inputs.push({
    name,
    type: inputType,
    description: elements.inputDescription.value.trim(),
    otp_login: inputType === "2fa_otp" ? elements.inputAccount.value.trim() : ""
  });
  elements.inputName.value = "";
  elements.inputDescription.value = "";
  elements.inputAccount.value = "";
  elements.inputType.value = "string";
  refreshInputAccountState();
  renderInputs();
}

function removeInput() {
  if (state.selectedInput < 0) return;
  state.inputs.splice(state.selectedInput, 1);
  state.selectedInput = -1;
  renderInputs();
}

function renderInputs() {
  state.inputs = normalizeInputSpecs(state.inputs);
  elements.inputTableBody.innerHTML = state.inputs
    .map(
      (item, index) => `
        <tr data-index="${index}" class="${index === state.selectedInput ? "selected" : ""}">
          <td><input type="radio" name="input-select" ${index === state.selectedInput ? "checked" : ""} /></td>
          <td>${escapeHtml(item.type)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.description || "")}</td>
          <td>${escapeHtml(item.otp_login || "")}</td>
        </tr>
      `
    )
    .join("");
  elements.inputTableBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedInput = Number(row.dataset.index);
      renderInputs();
    });
  });
}

function renderOtpAccounts() {
  elements.otpTableBody.innerHTML = state.otpAccounts
    .map(
      (account, index) => `
        <tr data-index="${index}" class="${index === state.selectedOtp ? "selected" : ""}">
          <td><input type="radio" name="otp-select" ${index === state.selectedOtp ? "checked" : ""} /></td>
          <td>${escapeHtml(account.login)}</td>
          <td>${escapeHtml(account.updated_at || "")}</td>
        </tr>
      `
    )
    .join("");
  elements.otpTableBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedOtp = Number(row.dataset.index);
      const account = state.otpAccounts[state.selectedOtp];
      if (account) {
        elements.otpLogin.value = account.login;
      }
      renderOtpAccounts();
    });
  });
}

async function saveOtpAccount() {
  const login = elements.otpLogin.value.trim();
  const secret = elements.otpSecret.value.trim();
  if (!login || !secret) {
    alert("Login and secret are required.");
    return;
  }
  await apiJson("/api/otp-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, secret })
  });
  elements.otpSecret.value = "";
  await refreshOtpAccounts();
}

async function deleteOtpAccount() {
  const login = elements.otpLogin.value.trim() || state.otpAccounts[state.selectedOtp]?.login || "";
  if (!login) {
    alert("Select an OTP account first.");
    return;
  }
  if (!confirm(`Delete OTP account '${login}'?`)) {
    return;
  }
  await apiJson(`/api/otp-accounts/${encodeURIComponent(login)}`, { method: "DELETE" });
  elements.otpLogin.value = "";
  elements.otpSecret.value = "";
  await refreshOtpAccounts();
}

function insertPlaceholderFromForm() {
  const inputType = elements.inputType.value;
  let name = normalizeInputName(elements.inputName.value);
  if (!name) {
    name = prompt("Variable name", "") || "";
    name = normalizeInputName(name);
  }
  if (!name) {
    alert("Enter a valid name first.");
    return;
  }
  ensureInputSpec(name, inputType, elements.inputDescription.value.trim(), inputType === "2fa_otp" ? elements.inputAccount.value.trim() : "");
  insertText(`{{INPUT:${name}}}`);
}

function insertOtpPlaceholder() {
  ensureInputSpec("2fa_otp", "2fa_otp", "Generated 2FA one-time password", elements.inputAccount.value.trim());
  insertText("{{INPUT:2fa_otp}}");
}

function insertText(text) {
  const editor = elements.editor;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(text, start, end, "end");
  editor.focus();
  setDirty(true);
  syncInputsFromText(editor.value);
}

function ensureInputSpec(name, type, description, otpLogin) {
  const existing = state.inputs.find((item) => item.name === name);
  if (existing) {
    existing.type = type;
    existing.description = description || existing.description || "";
    existing.otp_login = type === "2fa_otp" ? otpLogin || existing.otp_login || "" : "";
  } else {
    state.inputs.push({
      name,
      type,
      description: description || "",
      otp_login: type === "2fa_otp" ? otpLogin || "" : ""
    });
  }
  renderInputs();
}

function syncInputsFromText(text) {
  const names = extractInputPlaceholders(text);
  names.forEach((name) => {
    if (state.inputs.some((item) => item.name === name)) {
      return;
    }
    state.inputs.push({
      name,
      type: name === "2fa_otp" ? "2fa_otp" : "string",
      description: name === "2fa_otp" ? "Generated 2FA one-time password" : "",
      otp_login: ""
    });
  });
  renderInputs();
}

function buildMetadataForReplay() {
  const text = elements.editor.value;
  const usedInputs = filterInputSpecs(state.inputs, extractInputPlaceholders(text));
  return {
    schema_version: 2,
    scenario_type: "playwright-test-ts",
    project_id: elements.projectSelect.value,
    env_id: elements.envSelect.value,
    folder_path: normalizeFolderPath(elements.folderPath.value),
    scenario_name: elements.scenarioName.value.trim() || "New Scenario",
    scenario_slug: slugify(elements.scenarioName.value.trim() || "New Scenario"),
    recorded_at: new Date().toISOString(),
    recorded_by: state.config.default_user,
    recorded_base_url: resolveStartUrl(),
    run_base_url: resolveStartUrl(),
    outputs: state.outputs,
    inputs: usedInputs,
    browser: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: "ru-RU",
    timezone: "Europe/Riga",
    requires_auth: Boolean(state.runtime?.auth_state_path),
    auth_state_ref: state.runtime?.auth_state_path ? state.runtime.auth_state_path.split(/[\\/]/).pop() : null
  };
}

function resolveStartUrl() {
  return elements.startUrl.value.trim() || currentEnv()?.base_url || "";
}

function refreshInputAccountOptions() {
  const values = ["", ...state.otpAccounts.map((item) => item.login)];
  elements.inputAccount.innerHTML = values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value || "select OTP login")}</option>`)
    .join("");
}

function refreshInputAccountState() {
  refreshInputAccountOptions();
  const isOtp = elements.inputType.value === "2fa_otp";
  elements.inputAccount.disabled = !isOtp;
  if (!isOtp) {
    elements.inputAccount.value = "";
  }
}

function setDirty(value) {
  state.dirty = value;
  elements.editorDirty.textContent = value ? "unsaved" : "saved";
  updateButtons();
}

async function apiJson(url, init = {}) {
  const response = await fetch(`${state.config.server_url}${url}`, {
    ...init,
    headers: {
      ...(state.config.api_key ? { "X-API-KEY": state.config.api_key } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json();
}

function normalizeFolderPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeInputName(value) {
  const text = String(value || "").trim();
  return /^[\p{L}\p{N}_]+$/u.test(text) ? text : "";
}

function normalizeInputSpecs(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      name: normalizeInputName(item.name),
      type: item.type === "2fa_otp" ? "2fa_otp" : item.name === "2fa_otp" ? "2fa_otp" : "string",
      description: String(item.description || "").trim(),
      otp_login: String(item.otp_login || "").trim()
    }))
    .filter((item) => item.name && !seen.has(item.name) && seen.add(item.name));
}

function filterInputSpecs(inputs, names) {
  const allowed = new Set(names);
  return normalizeInputSpecs(inputs).filter((item) => allowed.has(item.name));
}

function extractInputPlaceholders(text) {
  const matches = String(text || "").matchAll(/\{\{INPUT:([\p{L}\p{N}_]+)\}\}/gu);
  const names = [];
  const seen = new Set();
  for (const match of matches) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "scenario";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
