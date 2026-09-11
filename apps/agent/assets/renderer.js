const state = {
  config: null,
  runtime: null,
  projects: [],
  envs: [],
  outputs: [],
  inputs: [],
  accounts: [],
  merchants: [],
  selectedOutput: -1,
  selectedInput: -1,
  selectedAccount: -1,
  selectedMerchant: -1,
  dirty: false,
  lastErrorSeen: "",
  editorContextTarget: null,
  editorContextSelection: { start: 0, end: 0 },
  editorContextMenuView: "root",
  editorContextMenuPoint: { x: 0, y: 0 }
};

const elements = {
  projectSelect: document.getElementById("project-select"),
  envSelect: document.getElementById("env-select"),
  scenarioName: document.getElementById("scenario-name"),
  folderPath: document.getElementById("folder-path"),
  startUrl: document.getElementById("start-url"),
  saveAuth: document.getElementById("save-auth"),
  runtimeStatus: document.getElementById("runtime-status"),
  toastContainer: document.getElementById("toast-container"),
  authServer: document.getElementById("auth-server"),
  authServerUrl: document.getElementById("auth-server-url"),
  authServerSaveBtn: document.getElementById("auth-server-save-btn"),
  authStatus: document.getElementById("auth-status"),
  authToken: document.getElementById("auth-token"),
  authSaveBtn: document.getElementById("auth-save-btn"),
  authClearBtn: document.getElementById("auth-clear-btn"),
  currentFile: document.getElementById("current-file"),
  preparedZip: document.getElementById("prepared-zip"),
  editor: document.getElementById("editor"),
  editorDirty: document.getElementById("editor-dirty"),
  editorContextMenu: document.getElementById("editor-context-menu"),
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
  accountTableBody: document.querySelector("#account-table tbody"),
  merchantTableBody: document.querySelector("#merchant-table tbody"),
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
  serverTokenButtons: Array.from(document.querySelectorAll("[data-server-token-btn]")),
  accountRefreshBtn: document.getElementById("account-refresh-btn"),
  merchantRefreshBtn: document.getElementById("merchant-refresh-btn")
};

window.addEventListener("DOMContentLoaded", async () => {
  state.config = await window.agent.getConfig();
  bindEvents();
  await refreshAuthStatus();
  await refreshAll();
  await refreshRuntime();
  // Real-time status is pushed from the main process; a slow poll is only a safety net.
  if (typeof window.agent.onRuntime === "function") {
    window.agent.onRuntime(applyRuntime);
  }
  setInterval(refreshRuntime, 8000);
});

function bindEvents() {
  elements.projectSelect.addEventListener("change", refreshEnvs);
  elements.inputType.addEventListener("change", refreshInputAccountState);
  elements.refreshBtn.addEventListener("click", refreshAll);
  elements.authSaveBtn.addEventListener("click", saveToken);
  elements.authClearBtn.addEventListener("click", clearToken);
  elements.authServerSaveBtn.addEventListener("click", () => void saveServerUrl().catch(showError));
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
  elements.serverTokenButtons.forEach((button) =>
    button.addEventListener("click", () => insertServerTokenFromButton(button.dataset.serverTokenBtn || ""))
  );
  elements.accountRefreshBtn.addEventListener("click", refreshAccounts);
  elements.merchantRefreshBtn.addEventListener("click", refreshMerchants);
  elements.editor.addEventListener("input", () => setDirty(true));
  document.addEventListener("contextmenu", handleEditableContextMenu);
  elements.editorContextMenu.addEventListener("click", handleEditorContextMenuClick);
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("focusin", handleDocumentFocusIn);
  document.addEventListener("scroll", hideEditorContextMenu, true);
  document.addEventListener("keydown", handleDocumentKeyDown);
  window.addEventListener("resize", hideEditorContextMenu);
}

async function refreshAll() {
  await Promise.all([refreshProjects(), refreshAccounts(), refreshMerchants()]);
  renderOutputs();
  renderInputs();
  refreshInputAccountState();
}

// Auth status bar (Phase 4 / 4.1) — shows the server and who the stored credential authenticates as.
async function refreshAuthStatus() {
  try {
    const status = await window.agent.getAuthStatus();
    elements.authServer.textContent = status.server_url || "—";
    elements.authServerUrl.value = status.server_url || "";
    if (status.user) {
      elements.authStatus.textContent = `${status.user.login} (${status.user.role})`;
    } else if (status.has_token) {
      elements.authStatus.textContent = status.reachable ? "token rejected — sign in again" : "server unreachable";
    } else if (status.api_key_set) {
      elements.authStatus.textContent = "machine API key (no user)";
    } else {
      elements.authStatus.textContent = "not signed in";
    }
    if (!status.encryption_available && status.has_token) {
      elements.authStatus.textContent += " · token stored unencrypted";
    }
  } catch (error) {
    elements.authStatus.textContent = `auth check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function saveServerUrl() {
  const serverUrl = elements.authServerUrl.value.trim();
  if (!serverUrl) {
    throw new Error("Enter the server URL");
  }
  const result = await window.agent.setServerUrl(serverUrl);
  state.config = await window.agent.getConfig();
  elements.authServerUrl.value = result.server_url;
  await refreshAuthStatus();
  await refreshAll();
  toast("Server URL saved", "success");
}

async function saveToken() {
  const token = elements.authToken.value.trim();
  if (!token) {
    return;
  }
  await window.agent.setToken(token);
  elements.authToken.value = "";
  await refreshAuthStatus();
  await refreshAll();
}

async function clearToken() {
  await window.agent.setToken("");
  elements.authToken.value = "";
  await refreshAuthStatus();
}

async function refreshProjects() {
  const projects = await apiJson("/api/projects");
  state.projects = Array.isArray(projects) ? projects : [];
  const selected = elements.projectSelect.value || state.projects[0]?.id || "";
  elements.projectSelect.innerHTML = state.projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.id)}</option>`)
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
    .map((env) => `<option value="${escapeHtml(env.id)}">${escapeHtml(env.name || env.id)}</option>`)
    .join("");
  elements.envSelect.value = state.envs.some((item) => item.id === selected) ? selected : state.envs[0]?.id || "";
  if (!elements.startUrl.value && currentEnv()) {
    elements.startUrl.value = currentEnv().base_url || "";
  }
}

async function refreshAccounts() {
  const accounts = await apiJson("/api/accounts");
  state.accounts = Array.isArray(accounts) ? accounts : [];
  renderAccounts();
}

async function refreshMerchants() {
  const merchants = await apiJson("/api/merchants");
  state.merchants = Array.isArray(merchants) ? merchants : [];
  renderMerchants();
}

// Apply a runtime snapshot to the UI (Phase 4 / 4.5). Driven by the main process push event and a
// slow safety poll, instead of the old 1s polling loop.
function applyRuntime(runtime) {
  if (!runtime) {
    return;
  }
  state.runtime = runtime;
  elements.runtimeStatus.textContent = runtime.status;
  elements.currentFile.textContent = runtime.test_path || "-";
  elements.preparedZip.textContent = runtime.zip_path || "-";
  if (runtime.last_error && runtime.last_error !== state.lastErrorSeen) {
    state.lastErrorSeen = runtime.last_error;
    toast(runtime.last_error, "error");
  }
  updateButtons();
}

async function refreshRuntime() {
  applyRuntime(await window.agent.getRuntimeState());
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
    toast("Start URL is required.");
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
    toast("No test file recorded yet.");
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
    toast("No test file recorded yet.");
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
  toast(`Replay finished with status: ${result.status}`);
  await refreshRuntime();
}

async function uploadScenario() {
  if (!state.runtime?.test_path) {
    toast("No test file recorded yet.");
    return;
  }
  if (state.dirty) {
    await saveEdits();
  }
  if (elements.saveAuth.checked && !state.runtime.auth_state_path) {
    toast("Auth state was not saved. Record again with 'Save auth state' enabled.");
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
  toast(`Scenario uploaded: ${response.uploaded.id}`, "success");
}

function addOutput() {
  const key = elements.outputKey.value.trim();
  const selector = elements.outputSelector.value.trim();
  const mode = elements.outputMode.value.trim();
  const attr = elements.outputAttr.value.trim();
  const frame = elements.outputFrame.value.trim();
  const timeout = elements.outputTimeout.value.trim();
  if (!key || !selector) {
    toast("Variable name and selector/xpath are required.");
    return;
  }
  if (mode === "attr" && !attr) {
    toast("Attr is required for attr mode.");
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
    toast("Name must contain only letters, digits, or underscores.");
    return;
  }
  if (state.inputs.some((item) => item.name === name)) {
    toast(`Variable '${name}' already exists.`);
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

// Read-only accounts list (Phase 4 / 4.4). The masked /api/accounts returns {login, has_totp, …};
// management lives in the web app. Row selection picks the login used for a live 2FA code.
function renderAccounts() {
  elements.accountTableBody.innerHTML = state.accounts
    .map(
      (account, index) => `
        <tr data-index="${index}" class="${index === state.selectedAccount ? "selected" : ""}">
          <td><input type="radio" name="account-select" ${index === state.selectedAccount ? "checked" : ""} /></td>
          <td>${escapeHtml(account.login)}</td>
          <td>${account.has_totp ? "🔐" : ""}</td>
        </tr>
      `
    )
    .join("");
  elements.accountTableBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedAccount = Number(row.dataset.index);
      renderAccounts();
    });
  });
}

function renderMerchants() {
  elements.merchantTableBody.innerHTML = state.merchants
    .map(
      (merchant, index) => `
        <tr data-index="${index}" class="${index === state.selectedMerchant ? "selected" : ""}">
          <td><input type="radio" name="merchant-select" ${index === state.selectedMerchant ? "checked" : ""} /></td>
          <td>${escapeHtml(merchant.name)}</td>
        </tr>
      `
    )
    .join("");
  elements.merchantTableBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedMerchant = Number(row.dataset.index);
      renderMerchants();
    });
  });
}

function insertPlaceholderFromForm() {
  const inputType = elements.inputType.value;
  let name = normalizeInputName(elements.inputName.value);
  if (!name) {
    name = prompt("Variable name", "") || "";
    name = normalizeInputName(name);
  }
  if (!name) {
    toast("Enter a valid name first.");
    return;
  }
  ensureInputSpec(name, inputType, elements.inputDescription.value.trim(), inputType === "2fa_otp" ? elements.inputAccount.value.trim() : "");
  insertText(`{{INPUT:${name}}}`);
}

function insertOtpPlaceholder() {
  insertDefaultOtpPlaceholder();
}

function insertServerTokenFromButton(tokenName) {
  if (!tokenName) {
    return;
  }
  focusInsertionTarget();
  insertServerToken(tokenName);
}

function handleEditableContextMenu(event) {
  const target = findEditableTarget(event.target);
  if (!target) {
    hideEditorContextMenu();
    return;
  }
  openEditorContextMenu(event, target);
}

function openEditorContextMenu(event, target = elements.editor) {
  event.preventDefault();
  state.editorContextTarget = target;
  state.editorContextSelection = {
    start: target.selectionStart ?? 0,
    end: target.selectionEnd ?? 0
  };
  state.editorContextMenuPoint = { x: event.clientX, y: event.clientY };
  renderEditorContextMenu("root");
}

function handleEditorContextMenuClick(event) {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const menuView = button.dataset.menuView;
  if (menuView) {
    renderEditorContextMenu(menuView);
    return;
  }

  const inputName = button.dataset.inputName;
  if (inputName) {
    hideEditorContextMenu();
    insertPlaceholder(inputName);
    return;
  }

  if (button.dataset.serverToken) {
    hideEditorContextMenu();
    insertServerToken(button.dataset.serverToken);
    return;
  }

  if (button.dataset.action) {
    void handleEditorContextAction(button.dataset.action).catch(showError);
    return;
  }

  if (button.dataset.createInput === "true") {
    hideEditorContextMenu();
    createInputVariableFromMenu();
    return;
  }

  if (button.dataset.createOtp === "true") {
    hideEditorContextMenu();
    createOtpVariableFromMenu();
  }
}

function handleDocumentMouseDown(event) {
  if (elements.editorContextMenu.classList.contains("hidden")) {
    return;
  }
  if (elements.editorContextMenu.contains(event.target)) {
    return;
  }
  hideEditorContextMenu();
}

function handleDocumentFocusIn(event) {
  const target = findEditableTarget(event.target);
  if (!target) {
    return;
  }
  state.editorContextTarget = target;
  state.editorContextSelection = {
    start: target.selectionStart ?? 0,
    end: target.selectionEnd ?? 0
  };
}

function handleDocumentKeyDown(event) {
  if (event.key === "Escape") {
    hideEditorContextMenu();
    return;
  }
  const editableTarget = findEditableTarget(document.activeElement) || findEditableTarget(state.editorContextTarget);
  if (!editableTarget) {
    return;
  }
  state.editorContextTarget = editableTarget;
  state.editorContextSelection = {
    start: editableTarget.selectionStart ?? 0,
    end: editableTarget.selectionEnd ?? 0
  };
  if (!isShortcutModifier(event)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "z") {
    event.preventDefault();
    applyNativeEditAction(event.shiftKey ? "redo" : "undo");
    return;
  }
  if (key === "c") {
    event.preventDefault();
    void handleClipboardAction("copy").catch(showError);
    return;
  }
  if (key === "v") {
    event.preventDefault();
    void handleClipboardAction("paste").catch(showError);
  }
}

function renderEditorContextMenu(view) {
  state.editorContextMenuView = view;
  elements.editorContextMenu.innerHTML = buildEditorContextMenuHtml(view);
  elements.editorContextMenu.classList.remove("hidden");
  elements.editorContextMenu.setAttribute("aria-hidden", "false");
  positionEditorContextMenu();
}

function hideEditorContextMenu() {
  elements.editorContextMenu.classList.add("hidden");
  elements.editorContextMenu.setAttribute("aria-hidden", "true");
}

function positionEditorContextMenu() {
  const menu = elements.editorContextMenu;
  if (menu.classList.contains("hidden")) {
    return;
  }
  const margin = 12;
  let x = state.editorContextMenuPoint.x;
  let y = state.editorContextMenuPoint.y;
  const rect = menu.getBoundingClientRect();
  if (x + rect.width + margin > window.innerWidth) {
    x = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (y + rect.height + margin > window.innerHeight) {
    y = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function buildEditorContextMenuHtml(view) {
  if (view === "otp") {
    return buildOtpContextMenuHtml();
  }
  if (view === "input") {
    return buildInputContextMenuHtml();
  }
  if (view === "server") {
    return buildServerContextMenuHtml();
  }
  const target = getActiveEditableTarget();
  const canInsertVariables = target === elements.editor;
  return `
    <div class="context-menu-section">
      <button type="button" class="context-menu-item" data-action="undo">Undo</button>
      <button type="button" class="context-menu-item" data-action="redo">Redo</button>
      <button type="button" class="context-menu-item" data-action="copy">Copy</button>
      <button type="button" class="context-menu-item" data-action="paste">Paste</button>
    </div>
    ${
      canInsertVariables
        ? `
    <div class="context-menu-section">
      <button type="button" class="context-menu-item" data-action="insert-default-otp">Insert 2FA OTP</button>
      <button type="button" class="context-menu-item" data-menu-view="otp">Input 2FA OTP</button>
      <button type="button" class="context-menu-item" data-menu-view="input">Input Variable</button>
      <button type="button" class="context-menu-item" data-menu-view="server">Server Tokens</button>
    </div>
    `
        : `
    <div class="context-menu-section">
      <button type="button" class="context-menu-item" data-action="insert-live-otp">Insert 2FA</button>
    </div>
    `
    }
  `;
}

function buildServerContextMenuHtml() {
  const items = [
    { name: "server_username", label: "{server_username}" },
    { name: "server_password", label: "{server_password}" },
    { name: "server_2faotp", label: "{server_2faotp}" },
    { name: "server_merchant", label: "{server_merchant}" }
  ]
    .map(
      (item) =>
        `<button type="button" class="context-menu-item" data-server-token="${escapeHtml(item.name)}">${escapeHtml(item.label)}</button>`
    )
    .join("");

  return `
    <div class="context-menu-header">
      <button type="button" class="context-menu-back" data-menu-view="root">Back</button>
      <strong>Server Tokens</strong>
    </div>
    <div class="context-menu-section">
      <div class="context-menu-title">Run-Time Server Data</div>
      ${items}
    </div>
  `;
}

function buildOtpContextMenuHtml() {
  const otpInputs = state.inputs.filter((item) => item.type === "2fa_otp");
  const existingButtons = otpInputs
    .map(
      (item) =>
        `<button type="button" class="context-menu-item" data-input-name="${escapeHtml(item.name)}">${escapeHtml(
          item.otp_login ? `${item.name} (configured)` : item.name
        )}</button>`
    )
    .join("");

  return `
    <div class="context-menu-header">
      <button type="button" class="context-menu-back" data-menu-view="root">Back</button>
      <strong>Input 2FA OTP</strong>
    </div>
    <div class="context-menu-section">
      <div class="context-menu-title">Existing 2FA Variables</div>
      ${existingButtons || '<div class="context-menu-empty">No 2FA variables yet.</div>'}
    </div>
    <div class="context-menu-section">
      <button type="button" class="context-menu-item" data-create-otp="true">Create 2FA variable</button>
    </div>
  `;
}

function buildInputContextMenuHtml() {
  const stringInputs = state.inputs.filter((item) => item.type !== "2fa_otp");
  const inputButtons = stringInputs
    .map(
      (item) =>
        `<button type="button" class="context-menu-item" data-input-name="${escapeHtml(item.name)}">${escapeHtml(
          item.name
        )}</button>`
    )
    .join("");

  return `
    <div class="context-menu-header">
      <button type="button" class="context-menu-back" data-menu-view="root">Back</button>
      <strong>Input Variable</strong>
    </div>
    <div class="context-menu-section">
      <div class="context-menu-title">Existing Variables</div>
      ${inputButtons || '<div class="context-menu-empty">No input variables yet.</div>'}
    </div>
    <div class="context-menu-section">
      <button type="button" class="context-menu-item" data-create-input="true">Create variable</button>
    </div>
  `;
}

function createInputVariableFromMenu() {
  const suggestion = suggestUniqueInputName("input_value");
  const rawName = prompt("Variable name", suggestion);
  if (rawName === null) {
    return;
  }
  const name = normalizeInputName(rawName);
  if (!name) {
    toast("Name must contain only letters, digits, or underscores.");
    return;
  }
  const existing = state.inputs.find((item) => item.name === name);
  if (existing && existing.type === "2fa_otp") {
    toast(`Variable '${name}' is already used as 2FA OTP.`);
    return;
  }
  ensureInputSpec(name, "string", existing?.description || "", "");
  insertPlaceholder(name);
}

function createOtpVariableFromMenu(login = "") {
  const suggestion = suggestUniqueInputName(login ? `otp_${toInputNameFragment(login)}` : "2fa_otp");
  const rawName = prompt("2FA variable name", suggestion);
  if (rawName === null) {
    return;
  }
  const name = normalizeInputName(rawName);
  if (!name) {
    toast("Name must contain only letters, digits, or underscores.");
    return;
  }
  const existing = state.inputs.find((item) => item.name === name);
  if (existing && existing.type !== "2fa_otp") {
    toast(`Variable '${name}' already exists and is not a 2FA OTP.`);
    return;
  }
  if (existing && login && existing.otp_login && existing.otp_login !== login) {
    toast(`Variable '${name}' is already linked to OTP account '${existing.otp_login}'.`);
    return;
  }
  ensureInputSpec(
    name,
    "2fa_otp",
    login ? `Generated 2FA one-time password for ${login}` : "Generated 2FA one-time password",
    login
  );
  insertPlaceholder(name);
}

function insertPlaceholder(name) {
  restoreEditorSelection();
  insertText(`{{INPUT:${name}}}`);
}

function insertServerToken(name) {
  restoreEditorSelection();
  insertText(`{${name}}`);
}

function restoreEditorSelection() {
  const target = getActiveEditableTarget();
  const start = state.editorContextSelection.start ?? target.selectionStart ?? 0;
  const end = state.editorContextSelection.end ?? target.selectionEnd ?? start;
  target.focus();
  target.setSelectionRange(start, end);
}

function insertText(text) {
  const target = getActiveEditableTarget();
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? start;
  target.setRangeText(text, start, end, "end");
  target.focus();
  target.dispatchEvent(new Event("input", { bubbles: true }));
  if (target === elements.editor) {
    setDirty(true);
    syncInputsFromText(target.value);
  }
}

function focusInsertionTarget() {
  const activeTarget = findEditableTarget(document.activeElement);
  state.editorContextTarget = activeTarget || elements.editor;
  const target = getActiveEditableTarget();
  state.editorContextSelection = {
    start: target.selectionStart ?? 0,
    end: target.selectionEnd ?? 0
  };
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

function refreshInputAccountState() {
  const isOtp = elements.inputType.value === "2fa_otp";
  elements.inputAccount.disabled = !isOtp;
  elements.inputAccount.placeholder = isOtp ? "OTP source (optional)" : "OTP source (optional)";
  if (!isOtp) {
    elements.inputAccount.value = "";
  }
}

function setDirty(value) {
  state.dirty = value;
  elements.editorDirty.textContent = value ? "unsaved" : "saved";
  updateButtons();
}

// Non-blocking, copyable toast (Phase 4) — replaces toast(). Messages (often server errors) can be
// copied to the clipboard via the main process and auto-dismiss; errors persist longer.
function toast(message, kind = "info") {
  const container = elements.toastContainer;
  const text = String(message ?? "");
  if (!container) {
    return;
  }
  const item = document.createElement("div");
  const accent = kind === "error" ? "var(--status-failed, #c0392b)" : kind === "success" ? "#1e8e3e" : "#3367d6";
  item.setAttribute(
    "style",
    `display:flex;gap:8px;align-items:flex-start;background:#1f2330;color:#fff;border-left:4px solid ${accent};` +
      "padding:10px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.35);font-size:13px;"
  );
  const body = document.createElement("span");
  body.style.flex = "1";
  body.style.whiteSpace = "pre-wrap";
  body.style.wordBreak = "break-word";
  body.textContent = text;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => window.agent.clipboardWriteText(text));
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => item.remove());
  item.append(body, copyBtn, closeBtn);
  container.appendChild(item);
  setTimeout(() => item.remove(), kind === "error" ? 12000 : 6000);
}

async function apiJson(url, init = {}) {
  // The auth header (PAT bearer or legacy API key) is computed in the main process so the raw
  // token never lives in the renderer (Phase 4 / 4.1).
  const authHeader = await window.agent.getAuthHeader();
  const response = await fetch(`${state.config.server_url}${url}`, {
    ...init,
    headers: {
      ...authHeader,
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

function toInputNameFragment(value) {
  const text = String(value || "")
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return normalizeInputName(text) || "value";
}

function suggestUniqueInputName(base) {
  const root = normalizeInputName(base) || toInputNameFragment(base);
  let candidate = root || "value";
  let index = 2;
  while (state.inputs.some((item) => item.name === candidate)) {
    candidate = `${root}_${index}`;
    index += 1;
  }
  return candidate;
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

function findEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  const editable = target.closest("textarea, input");
  if (!(editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement)) {
    return null;
  }
  if (editable.disabled || editable.readOnly) {
    return null;
  }
  const type = (editable.type || "text").toLowerCase();
  if (
    editable instanceof HTMLInputElement &&
    !["", "text", "search", "url", "password", "email", "tel", "number"].includes(type)
  ) {
    return null;
  }
  return editable;
}

function getActiveEditableTarget() {
  return state.editorContextTarget && findEditableTarget(state.editorContextTarget)
    ? state.editorContextTarget
    : elements.editor;
}

function isShortcutModifier(event) {
  return Boolean(event.ctrlKey || event.metaKey);
}

function applyNativeEditAction(action) {
  hideEditorContextMenu();
  const target = getActiveEditableTarget();
  target.focus();
  document.execCommand(action);
}

async function handleClipboardAction(action) {
  hideEditorContextMenu();
  const target = getActiveEditableTarget();
  target.focus();
  if (action === "copy") {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    if (start === end) {
      return;
    }
    await window.agent.clipboardWriteText(target.value.slice(start, end));
    return;
  }
  if (action === "paste") {
    restoreEditorSelection();
    const text = await window.agent.clipboardReadText();
    if (text) {
      insertText(text);
    }
  }
}

async function handleEditorContextAction(action) {
  if (action === "undo" || action === "redo") {
    applyNativeEditAction(action);
    return;
  }
  if (action === "copy" || action === "paste") {
    await handleClipboardAction(action);
    return;
  }
  if (action === "insert-default-otp") {
    hideEditorContextMenu();
    insertDefaultOtpPlaceholder();
    return;
  }
  if (action === "insert-live-otp") {
    hideEditorContextMenu();
    await insertLiveOtpCode(resolveDefaultOtpAccountLogin());
  }
}

function resolveDefaultOtpSource() {
  return elements.inputAccount.value.trim();
}

function resolveDefaultOtpAccountLogin() {
  return state.accounts[state.selectedAccount]?.login || state.accounts.find((account) => account.has_totp)?.login || "";
}

function insertDefaultOtpPlaceholder() {
  const otpSource = resolveDefaultOtpSource();
  ensureInputSpec("2fa_otp", "2fa_otp", "Generated 2FA one-time password", otpSource);
  insertPlaceholder("2fa_otp");
}

async function insertLiveOtpCode(login) {
  if (!login) {
    toast("No server account with 2FA OTP is configured.");
    return;
  }
  const otp = await apiJson("/api/accounts/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login })
  });
  restoreEditorSelection();
  insertText(String(otp.code || ""));
}

function showError(error) {
  toast(error instanceof Error ? error.message : String(error), "error");
}
