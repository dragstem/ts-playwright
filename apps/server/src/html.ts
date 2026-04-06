import type { ProjectRecord, RunRecord, ScenarioRecord, InputSpec } from "@ts-playwright/shared";

const BASE_CSS = `
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --text: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --accent: #2563eb;
  --danger: #ef4444;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.container { max-width: 1100px; margin: 32px auto; padding: 20px; background: var(--card); border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
.page-title { margin-bottom: 12px; }
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { margin-top: 24px; font-size: 16px; }
.muted { color: var(--muted); font-size: 0.9em; }
.breadcrumbs { display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.9em; color: var(--muted); margin-bottom: 10px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 16px; }
.input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; min-width: 220px; font-size: 0.95em; }
.btn { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: #fff; cursor: pointer; font-size: 0.95em; }
.btn-sm { padding: 4px 8px; font-size: 0.85em; }
.btn-danger { color: var(--danger); border-color: #fecaca; }
.list { list-style: none; padding: 0; margin: 0; }
.row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
.row-actions { display: flex; gap: 6px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.card { padding: 12px; border: 1px solid var(--border); border-radius: 8px; margin-top: 12px; background: #fbfbfb; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75em; background: #eef2ff; color: #3730a3; }
.badge-passed { background: #dcfce7; color: #166534; }
.badge-failed, .badge-error { background: #fee2e2; color: #991b1b; }
.badge-running, .badge-queued { background: #e0f2fe; color: #075985; }
.code-block { white-space: pre-wrap; background: #f3f4f6; padding: 14px; border-radius: 8px; border: 1px solid var(--border); }
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; align-items: center; justify-content: center; }
.modal-overlay.active { display: flex; }
.modal-box { background: #fff; border-radius: 6px; padding: 24px 28px; min-width: 340px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.18); }
.modal-field { margin-bottom: 12px; }
.modal-field label { display: block; font-size: 0.85rem; margin-bottom: 4px; font-weight: 500; }
.modal-field .field-desc { font-size: 0.78rem; color: #666; margin-bottom: 4px; }
.modal-field input, .modal-field select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
`;

export function renderProjectsPage(projects: ProjectRecord[]): string {
  return page("Projects", `
    <div class="container">
      <div class="page-title">
        <h1>Projects</h1>
        <div class="muted">TypeScript Playwright hub</div>
      </div>
      <ul class="list">
        ${projects
          .map(
            (project) => `
              <li class="row">
                <div>
                  <a href="/projects/${escapeAttr(project.id)}">${escapeHtml(project.name)}</a>
                  <div class="muted">${escapeHtml(project.description ?? "")}</div>
                </div>
              </li>
            `
          )
          .join("")}
      </ul>
    </div>
  `);
}

export function renderProjectPage(input: {
  project: ProjectRecord;
  folder_path: string;
  breadcrumbs: { name: string; path: string }[];
  subfolders: { name: string; path: string }[];
  scenarios: ScenarioRecord[];
}): string {
  const { project, folder_path, breadcrumbs, subfolders, scenarios } = input;
  const breadcrumbHtml = breadcrumbs
    .map(
      (crumb) => `
        <span>/</span>
        <a href="/projects/${escapeAttr(project.id)}?path=${encodeURIComponent(crumb.path)}">${escapeHtml(crumb.name)}</a>
      `
    )
    .join("");

  return page(
    project.name,
    `
      <div class="container">
        <div class="breadcrumbs">
          <a href="/">Projects</a>
          <span>/</span>
          <a href="/projects/${escapeAttr(project.id)}">${escapeHtml(project.name)}</a>
          ${breadcrumbHtml}
        </div>
        <div class="page-title">
          <h1>${escapeHtml(project.name)}</h1>
          <div class="muted">${escapeHtml(project.description ?? "")}</div>
        </div>
        <div class="toolbar">
          <input id="new-folder-input" class="input" type="text" placeholder="New folder name" />
          <button class="btn" id="create-folder-btn">Create folder</button>
        </div>
        <h2>Folders</h2>
        ${
          subfolders.length > 0
            ? `<ul class="list">${subfolders
                .map(
                  (folder) => `
                    <li class="row">
                      <div><a href="/projects/${escapeAttr(project.id)}?path=${encodeURIComponent(folder.path)}">${escapeHtml(folder.name)}</a></div>
                      <div class="row-actions">
                        <button class="btn btn-sm rename-folder" data-path="${escapeAttr(folder.path)}">Rename</button>
                        <button class="btn btn-sm btn-danger delete-folder" data-path="${escapeAttr(folder.path)}">Delete</button>
                      </div>
                    </li>
                  `
                )
                .join("")}</ul>`
            : `<div class="muted">No folders yet.</div>`
        }
        <h2>Scenarios</h2>
        ${
          scenarios.length > 0
            ? `<table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Env</th>
                    <th>CreatedBy</th>
                    <th>CreatedAt</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${scenarios
                    .map(
                      (scenario) => `
                        <tr>
                          <td>${escapeHtml(scenario.name)}</td>
                          <td>${escapeHtml(scenario.env_id)}</td>
                          <td>${escapeHtml(scenario.created_by)}</td>
                          <td>${escapeHtml(scenario.created_at)}</td>
                          <td>
                            <button type="button" class="btn btn-sm run-btn" data-scenario-id="${escapeAttr(scenario.id)}">Run</button>
                            <a class="btn btn-sm" href="/scenarios/${escapeAttr(scenario.id)}">Runs</a>
                            <a class="btn btn-sm" href="/scenarios/${escapeAttr(scenario.id)}/code">Code</a>
                            <button type="button" class="btn btn-sm move-scenario" data-scenario-id="${escapeAttr(scenario.id)}">Move</button>
                            <button type="button" class="btn btn-sm btn-danger delete-scenario" data-scenario-id="${escapeAttr(scenario.id)}">Delete</button>
                          </td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted">No scenarios in this folder.</div>`
        }
      </div>
    `,
    `
      const projectId = ${serializeJson(project.id)};
      const currentPath = ${serializeJson(folder_path)};

      document.getElementById("create-folder-btn").addEventListener("click", async () => {
        const input = document.getElementById("new-folder-input");
        const name = String(input.value || "").trim();
        if (!name) return;
        const path = currentPath ? \`\${currentPath}/\${name}\` : name;
        const resp = await fetch(\`/api/projects/\${projectId}/folders\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path })
        });
        if (!resp.ok) {
          alert(await resp.text());
          return;
        }
        location.reload();
      });

      document.querySelectorAll(".rename-folder").forEach((button) => {
        button.addEventListener("click", async () => {
          const fromPath = button.dataset.path;
          const parts = String(fromPath).split("/");
          const currentName = parts[parts.length - 1];
          const newName = prompt("New folder name", currentName);
          if (!newName) return;
          const base = parts.slice(0, -1).join("/");
          const toPath = base ? \`\${base}/\${newName}\` : newName;
          const resp = await fetch(\`/api/projects/\${projectId}/folders/move\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_path: fromPath, to_path: toPath })
          });
          if (!resp.ok) {
            alert(await resp.text());
            return;
          }
          location.reload();
        });
      });

      document.querySelectorAll(".delete-folder").forEach((button) => {
        button.addEventListener("click", async () => {
          const folderPath = button.dataset.path;
          if (!confirm(\`Delete folder "\${folderPath}" and everything inside?\`)) return;
          const resp = await fetch(\`/api/projects/\${projectId}/folders?path=\${encodeURIComponent(folderPath)}\`, { method: "DELETE" });
          if (!resp.ok) {
            alert(await resp.text());
            return;
          }
          location.reload();
        });
      });

      document.querySelectorAll(".run-btn").forEach((button) => {
        button.addEventListener("click", async () => {
          const scenarioId = button.dataset.scenarioId;
          button.disabled = true;
          button.textContent = "Queueing...";
          try {
            const resp = await fetch(\`/api/scenarios/\${scenarioId}/run\`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ inputs: {} })
            });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            location.href = \`/runs/\${data.id}\`;
          } catch (error) {
            alert("Run failed: " + error);
            button.disabled = false;
            button.textContent = "Run";
          }
        });
      });

      document.querySelectorAll(".move-scenario").forEach((button) => {
        button.addEventListener("click", async () => {
          const scenarioId = button.dataset.scenarioId;
          const target = prompt("Move to folder (empty = root)", currentPath);
          if (target === null) return;
          const resp = await fetch(\`/api/scenarios/\${scenarioId}/move\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target || "" })
          });
          if (!resp.ok) {
            alert(await resp.text());
            return;
          }
          location.reload();
        });
      });

      document.querySelectorAll(".delete-scenario").forEach((button) => {
        button.addEventListener("click", async () => {
          const scenarioId = button.dataset.scenarioId;
          if (!confirm("Delete scenario and its runs?")) return;
          const resp = await fetch(\`/api/scenarios/\${scenarioId}\`, { method: "DELETE" });
          if (!resp.ok) {
            alert(await resp.text());
            return;
          }
          location.reload();
        });
      });
    `
  );
}

export function renderScenarioPage(input: {
  scenario: ScenarioRecord;
  runs: RunRecord[];
  otp_logins: string[];
}): string {
  const interactiveInputs = input.scenario.inputs.filter((item) => !(item.type === "2fa_otp" && item.otp_login));

  return page(
    input.scenario.name,
    `
      <div class="container">
        <div class="breadcrumbs">
          <a href="/">Projects</a>
          <span>/</span>
          <a href="/projects/${escapeAttr(input.scenario.project_id)}${input.scenario.folder_path ? `?path=${encodeURIComponent(input.scenario.folder_path)}` : ""}">
            ${escapeHtml(input.scenario.project_id)}
          </a>
          <span>/</span>
          <span>${escapeHtml(input.scenario.name)}</span>
        </div>
        <div class="page-title">
          <h1>${escapeHtml(input.scenario.name)}</h1>
          <div class="muted">Folder: ${escapeHtml(input.scenario.folder_path || "/")}</div>
        </div>
        ${
          input.scenario.inputs.length > 0
            ? `<div class="card">
                <div class="muted">Input Variables</div>
                <table>
                  <thead><tr><th>Type</th><th>Name</th><th>Description</th><th>OTP account</th></tr></thead>
                  <tbody>
                    ${input.scenario.inputs
                      .map(
                        (spec) => `
                          <tr>
                            <td>${escapeHtml(spec.type)}</td>
                            <td><code>${escapeHtml(spec.name)}</code></td>
                            <td>${escapeHtml(spec.description || "-")}</td>
                            <td>${escapeHtml(spec.otp_login || "-")}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : ""
        }
        ${
          input.otp_logins.length > 0
            ? `<div class="card"><div class="muted">Available OTP logins</div><div>${escapeHtml(input.otp_logins.join(", "))}</div></div>`
            : ""
        }
        <div class="toolbar">
          <button type="button" class="btn btn-sm run-btn">Run</button>
          <a class="btn btn-sm" href="/scenarios/${escapeAttr(input.scenario.id)}/code">Code</a>
          <a class="btn btn-sm" href="/api/scenarios/${escapeAttr(input.scenario.id)}/download">Download</a>
          <button type="button" class="btn btn-sm move-scenario">Move</button>
          <button type="button" class="btn btn-sm btn-danger delete-scenario">Delete</button>
        </div>
        <h2>Runs</h2>
        ${
          input.runs.length > 0
            ? `<table>
                <thead><tr><th>Status</th><th>Started</th><th>Finished</th><th>Actions</th></tr></thead>
                <tbody>
                  ${input.runs
                    .map(
                      (run) => `
                        <tr>
                          <td><span class="badge badge-${escapeAttr(run.status)}">${escapeHtml(run.status)}</span></td>
                          <td>${escapeHtml(run.started_at ?? "")}</td>
                          <td>${escapeHtml(run.finished_at ?? "")}</td>
                          <td>
                            <a class="btn btn-sm" href="/runs/${escapeAttr(run.id)}">Open</a>
                            <button type="button" class="btn btn-sm btn-danger delete-run" data-run-id="${escapeAttr(run.id)}">Delete</button>
                          </td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="muted">No runs yet.</div>`
        }
      </div>
      <div class="modal-overlay" id="inputs-modal">
        <div class="modal-box">
          <h3>Run inputs</h3>
          <div id="modal-fields"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-sm" id="modal-cancel">Cancel</button>
            <button type="button" class="btn btn-sm" id="modal-confirm">Run</button>
          </div>
        </div>
      </div>
    `,
    `
      const scenarioId = ${serializeJson(input.scenario.id)};
      const currentFolder = ${serializeJson(input.scenario.folder_path)};
      const scenarioInputs = ${serializeJson(input.scenario.inputs)};
      const otpAccounts = ${serializeJson(input.otp_logins)};

      function interactiveInputs() {
        return scenarioInputs.filter((input) => !(input.type === "2fa_otp" && input.otp_login));
      }

      async function triggerRun(inputs) {
        const runButton = document.querySelector(".run-btn");
        if (runButton) {
          runButton.disabled = true;
          runButton.textContent = "Queueing...";
        }
        try {
          const resp = await fetch(\`/api/scenarios/\${scenarioId}/run\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputs })
          });
          if (!resp.ok) throw new Error(await resp.text());
          const data = await resp.json();
          location.href = \`/runs/\${data.id}\`;
        } catch (error) {
          alert("Run failed: " + error);
          if (runButton) {
            runButton.disabled = false;
            runButton.textContent = "Run";
          }
        }
      }

      const modal = document.getElementById("inputs-modal");
      const modalFields = document.getElementById("modal-fields");

      function openInputsModal() {
        modalFields.innerHTML = "";
        interactiveInputs().forEach((input) => {
          const field = document.createElement("div");
          field.className = "modal-field";
          const label = document.createElement("label");
          label.textContent = input.name + " *";
          field.appendChild(label);
          if (input.description) {
            const desc = document.createElement("div");
            desc.className = "field-desc";
            desc.textContent = input.description;
            field.appendChild(desc);
          }
          let control;
          if (input.type === "2fa_otp") {
            control = document.createElement("select");
            const empty = document.createElement("option");
            empty.value = "";
            empty.textContent = "Select OTP login";
            control.appendChild(empty);
            otpAccounts.forEach((login) => {
              const option = document.createElement("option");
              option.value = login;
              option.textContent = login;
              control.appendChild(option);
            });
          } else {
            control = document.createElement("input");
            control.type = "text";
            control.autocomplete = "off";
          }
          control.name = input.name;
          control.dataset.required = "1";
          field.appendChild(control);
          modalFields.appendChild(field);
        });
        modal.classList.add("active");
      }

      document.querySelector(".run-btn").addEventListener("click", () => {
        if (interactiveInputs().length === 0) {
          triggerRun({});
          return;
        }
        openInputsModal();
      });

      document.getElementById("modal-cancel").addEventListener("click", () => modal.classList.remove("active"));
      document.getElementById("modal-confirm").addEventListener("click", () => {
        const inputs = {};
        let valid = true;
        modalFields.querySelectorAll("input, select").forEach((element) => {
          if (element.dataset.required === "1" && !String(element.value || "").trim()) {
            element.style.borderColor = "red";
            valid = false;
          } else {
            element.style.borderColor = "";
            inputs[element.name] = element.value;
          }
        });
        if (!valid) return;
        modal.classList.remove("active");
        triggerRun(inputs);
      });
      modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.classList.remove("active");
      });

      document.querySelector(".move-scenario").addEventListener("click", async () => {
        const target = prompt("Move to folder (empty = root)", currentFolder);
        if (target === null) return;
        const resp = await fetch(\`/api/scenarios/\${scenarioId}/move\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target || "" })
        });
        if (!resp.ok) {
          alert(await resp.text());
          return;
        }
        const url = target ? \`/projects/${escapeJs(input.scenario.project_id)}?path=\${encodeURIComponent(target)}\` : \`/projects/${escapeJs(input.scenario.project_id)}\`;
        location.href = url;
      });

      document.querySelector(".delete-scenario").addEventListener("click", async () => {
        if (!confirm("Delete scenario and its runs?")) return;
        const resp = await fetch(\`/api/scenarios/\${scenarioId}\`, { method: "DELETE" });
        if (!resp.ok) {
          alert(await resp.text());
          return;
        }
        const backUrl = currentFolder ? \`/projects/${escapeJs(input.scenario.project_id)}?path=\${encodeURIComponent(currentFolder)}\` : \`/projects/${escapeJs(input.scenario.project_id)}\`;
        location.href = backUrl;
      });

      document.querySelectorAll(".delete-run").forEach((button) => {
        button.addEventListener("click", async () => {
          const runId = button.dataset.runId;
          if (!confirm("Delete this run?")) return;
          const resp = await fetch(\`/api/runs/\${runId}\`, { method: "DELETE" });
          if (!resp.ok) {
            alert(await resp.text());
            return;
          }
          location.reload();
        });
      });
    `
  );
}

export function renderRunPage(input: {
  run: RunRecord;
  scenario: ScenarioRecord | undefined;
  outputs: Record<string, unknown>;
}): string {
  return page(
    `Run ${input.run.id}`,
    `
      <div class="container">
        <div class="breadcrumbs">
          <a href="/">Projects</a>
          ${
            input.scenario
              ? `
                <span>/</span>
                <a href="/projects/${escapeAttr(input.scenario.project_id)}${input.scenario.folder_path ? `?path=${encodeURIComponent(input.scenario.folder_path)}` : ""}">
                  ${escapeHtml(input.scenario.project_id)}
                </a>
                <span>/</span>
                <a href="/scenarios/${escapeAttr(input.scenario.id)}">${escapeHtml(input.scenario.name)}</a>
              `
              : ""
          }
        </div>
        <div class="page-title">
          <h1>Run ${escapeHtml(input.run.id)}</h1>
          <div class="muted">Scenario run details</div>
        </div>
        <div class="toolbar">
          <a class="btn btn-sm" href="/api/runs/${escapeAttr(input.run.id)}/stdout">stdout</a>
          <a class="btn btn-sm" href="/api/runs/${escapeAttr(input.run.id)}/stderr">stderr</a>
          <a class="btn btn-sm" href="/api/runs/${escapeAttr(input.run.id)}/artifacts">artifacts</a>
          <button class="btn btn-sm btn-danger" id="delete-run-btn">Delete run</button>
        </div>
        <div class="card">
          <div>Status: <span id="run-status" class="badge badge-${escapeAttr(input.run.status)}">${escapeHtml(input.run.status)}</span></div>
          <div>Started: <span id="run-started">${escapeHtml(input.run.started_at ?? "")}</span></div>
          <div>Finished: <span id="run-finished">${escapeHtml(input.run.finished_at ?? "")}</span></div>
          <div id="run-live-note" class="muted">${input.run.status === "running" || input.run.status === "queued" ? "Run in progress. This page refreshes automatically." : ""}</div>
        </div>
        <div class="card">
          <div class="muted">Outputs:</div>
          ${
            Object.keys(input.outputs).length > 0
              ? `<table>
                  <thead><tr><th>Key</th><th>Value</th></tr></thead>
                  <tbody>
                    ${Object.entries(input.outputs)
                      .map(
                        ([key, value]) => `
                          <tr>
                            <td>${escapeHtml(key)}</td>
                            <td><code>${escapeHtml(JSON.stringify(value))}</code></td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>`
              : `<div class="muted">No outputs captured.</div>`
          }
        </div>
        <div class="card">
          <div class="muted">Artifacts:</div>
          <ul id="artifact-list"></ul>
        </div>
      </div>
    `,
    `
      const runId = ${serializeJson(input.run.id)};
      const terminalStatuses = new Set(["passed", "failed", "error"]);

      document.getElementById("delete-run-btn").addEventListener("click", async () => {
        if (!confirm("Delete this run?")) return;
        const resp = await fetch("/api/runs/${escapeJs(input.run.id)}", { method: "DELETE" });
        if (!resp.ok) {
          alert(await resp.text());
          return;
        }
        location.href = ${serializeJson(input.scenario ? `/scenarios/${input.scenario.id}` : "/")};
      });

      fetch("/api/runs/${escapeJs(input.run.id)}/artifacts")
        .then((response) => response.json())
        .then((data) => {
          const list = document.getElementById("artifact-list");
          list.innerHTML = "";
          (data.artifacts || []).forEach((name) => {
            const item = document.createElement("li");
            const link = document.createElement("a");
            const encoded = name.split("/").map(encodeURIComponent).join("/");
            link.href = "/api/runs/${escapeJs(input.run.id)}/artifacts/" + encoded;
            link.textContent = name;
            item.appendChild(link);
            list.appendChild(item);
          });
        })
        .catch(() => {});

      async function refreshRun() {
        try {
          const response = await fetch("/api/runs/" + encodeURIComponent(runId));
          if (!response.ok) {
            return;
          }
          const run = await response.json();
          const statusEl = document.getElementById("run-status");
          const startedEl = document.getElementById("run-started");
          const finishedEl = document.getElementById("run-finished");
          const noteEl = document.getElementById("run-live-note");

          statusEl.textContent = run.status;
          statusEl.className = "badge badge-" + run.status;
          startedEl.textContent = run.started_at || "";
          finishedEl.textContent = run.finished_at || "";
          noteEl.textContent = terminalStatuses.has(run.status) ? "" : "Run in progress. This page refreshes automatically.";

          if (terminalStatuses.has(run.status)) {
            location.reload();
          }
        } catch {
        }
      }

      if (!terminalStatuses.has(${serializeJson(input.run.status)})) {
        setInterval(refreshRun, 2000);
      }
    `
  );
}

export function renderCodePage(scenario: ScenarioRecord, code: string): string {
  return page(
    `${scenario.name} Code`,
    `
      <div class="container">
        <div class="breadcrumbs">
          <a href="/">Projects</a>
          <span>/</span>
          <a href="/projects/${escapeAttr(scenario.project_id)}${scenario.folder_path ? `?path=${encodeURIComponent(scenario.folder_path)}` : ""}">
            ${escapeHtml(scenario.project_id)}
          </a>
          <span>/</span>
          <a href="/scenarios/${escapeAttr(scenario.id)}">${escapeHtml(scenario.name)}</a>
          <span>/</span>
          <span>Code</span>
        </div>
        <div class="page-title">
          <h1>Scenario Code</h1>
          <div class="muted">${escapeHtml(scenario.name)} (${escapeHtml(scenario.id)})</div>
        </div>
        <pre class="code-block">${escapeHtml(code)}</pre>
      </div>
    `
  );
}

function page(title: string, body: string, script = ""): string {
  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(title)}</title>
      <style>${BASE_CSS}</style>
    </head>
    <body>
      ${body}
      ${script ? `<script>${script}</script>` : ""}
    </body>
  </html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

function escapeJs(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
