# ts-playwright

Standalone TypeScript implementation of the Playwright recording and execution system.

Use this directory as an independent project root. The legacy Python code in the parent folder is no longer required for runtime and should be treated only as historical reference while migration tails are being closed.

## What This Project Contains

- `apps/server` - Fastify server with API and minimal HTML UI for projects, scenarios, runs, folders, OTP accounts, artifacts, stdout and stderr.
- `apps/agent` - Electron desktop agent for recording, previewing, replaying and uploading `Playwright Test` scenarios.
- `packages/shared` - shared schemas, placeholder helpers, OTP/TOTP logic, metadata builders and storage helpers.
- `packages/runner` - scenario source preparation, local replay helpers and Docker-based server execution.

## Current Runtime Model

- Scenarios are stored as TypeScript Playwright Test files: `scenario.spec.ts`
- Each package also contains `metadata.json`
- Optional auth state is stored as `auth_state.json`
- Server-side execution uses Docker and a pinned Playwright image
- Local replay uses the same TypeScript runtime path instead of Python
- Project state is currently stored in `storage/app-state.json`

## Requirements

- Node.js 22+
- pnpm 10+ via Corepack
- Docker Desktop or compatible Docker runtime for server-side runs
- Playwright browsers installed locally for agent recording and local replay

## Quick Start

```powershell
cd ts-playwright
corepack pnpm install
corepack pnpm run playwright:install
corepack pnpm run build
```

If `corepack enable pnpm` fails on Windows with `EPERM` under `C:\Program Files\nodejs`, use `corepack pnpm ...` directly instead of enabling the global shim.

Start the server:

```powershell
corepack pnpm run start:server
```

Start the agent in another terminal:

```powershell
corepack pnpm run start:agent
```

Server default URL: `http://localhost:8000`

## Development Commands

```powershell
corepack pnpm run dev:server
corepack pnpm run dev:agent
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run build
```

Notes:

- `dev:server` runs the TypeScript server through `tsx watch`
- `dev:agent` starts the Electron app from built files
- `build` also copies static agent assets into `apps/agent/dist/assets`

## Codex Integration

This repository now includes project-local Codex integration for Playwright work:

- `AGENTS.md` adds repo guidance for Codex sessions
- `.agents/plugins/marketplace.json` registers the local Codex plugin
- `plugins/ts-playwright-codex/` contains the project plugin, wrapper skills, and Playwright MCP launcher
- `codex/playwright-mcp.config.json` contains the repo-local Playwright MCP config

Project-local Playwright skills:

- `ts-playwright-e2e`
- `ts-playwright-browser-debug`
- `ts-playwright-site-discovery`

These local entry points intentionally reuse the installed global Codex skills from `~/.codex/skills/`:

- `playwright-regression-orchestrator`
- `chrome-devtools`

`ts-playwright-site-discovery` is the discovery-oriented entry point: it uses the local Playwright MCP server to start from a URL, traverse nested functionality, and generate a structured Markdown artifact that can be reused for later test or action generation.

The project-local Playwright MCP wrapper expects:

- Node.js to be available on `PATH`
- the Playwright MCP package to exist at `~/.codex/playwright-mcp-package`

Additional project notes live in [codex/README.md](codex/README.md).

## Configuration

### Server

Environment variables:

- `APP_HOST` - server host, default `0.0.0.0`
- `APP_PORT` - server port, default `8000`
- `APP_STORAGE_DIR` - storage directory, default `<project>/storage`
- `APP_API_KEY` - optional API protection via `X-API-KEY`
- `APP_OTP_AUTOREPLACE` - optional OTP autofill rewrite toggle, accepts `1/true/yes`
- `APP_DOCKER_IMAGE` - optional Docker image override for scenario execution
- `APP_RUN_TIMEOUT_MS` - optional run timeout in milliseconds, default `900000`

### Agent

The agent reads config from one of these locations:

1. next to the executable: `config.json`
2. next to the executable: `config.example.json`
3. local dev build: `apps/agent/dist/assets/config.json`
4. local dev build: `apps/agent/dist/assets/config.example.json`

Example:

```json
{
  "server_url": "http://localhost:8000",
  "api_key": null,
  "default_user": "demo"
}
```

The template file is already included at [apps/agent/assets/config.example.json](apps/agent/assets/config.example.json).

## Storage Layout

Runtime data lives in `storage/`:

```text
storage/
  app-state.json
  projects/
    <project_id>/
      <folder...>/
        <scenario-dir>/
          package.zip
          runs/
            <run_id>/
              stdout.log
              stderr.log
              result.json
              outputs.json
              trace.zip
              screenshot_on_fail.png
              videos/
```

Important behaviors preserved from the earlier system:

- folder hierarchy is part of the project model
- path traversal outside project storage is blocked
- scenario folders are distinct from normal folders
- run artifacts remain inside each scenario directory

## Scenario Features

Supported business logic in the TypeScript version:

- input placeholders like `{{INPUT:user_name}}`
- OTP placeholders like `{{INPUT:2fa_otp}}`
- OTP account lookup by login
- file-based TOTP secret lookup for local Playwright flows
- on-demand TOTP code generation through the local server API
- runtime output capture into `outputs.json`
- optional auth state packaging and replay
- replacement of recorded base URL with runtime `BASE_URL`

## On-Demand 2FA For Playwright

For browser discovery or ad-hoc Playwright flows, do not hardcode a 6-digit OTP into the script. Store the TOTP secret once and generate a fresh code only when the UI actually asks for 2FA.

### Option 1: local text file with TOTP secrets

Put secrets into a git-ignored file such as `storage/totp-secrets.txt`:

```text
# login=BASE32_SECRET
qa-admin=BASE32SECRET
qa-manager=ANOTHERBASE32SECRET
```

The helper in `@ts-playwright/shared` can read that file and return a fresh code:

```ts
import { getOtpCodeFromFile } from "@ts-playwright/shared";

const otp = await getOtpCodeFromFile("qa-admin", "storage/totp-secrets.txt");
await page.getByLabel(/code|otp|verification/i).fill(otp.code);
```

For repo scenarios that already use `{{INPUT:2fa_otp}}`, the local runtime can also read the same file automatically:

```powershell
$env:TOTP_SECRETS_FILE = (Resolve-Path "storage/totp-secrets.txt")
```

Then pass the login name instead of the 6-digit code:

- scenario input name: `2fa_otp`
- scenario input value: `qa-admin`

When the runtime sees `input("2fa_otp")`, it will look up `qa-admin` in `TOTP_SECRETS_FILE` and generate a fresh TOTP code on demand.

### Option 2: local server API

If you prefer keeping secrets in the local server state, use the OTP account API.

1. Save an OTP account in the local server:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/otp-accounts -ContentType 'application/json' -Body '{"login":"qa-admin","secret":"BASE32SECRET"}'
```

2. When the Playwright flow reaches a 2FA challenge, request a fresh code:

```powershell
$otp = Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/otp-accounts/code -ContentType 'application/json' -Body '{"login":"qa-admin"}'
$otp.code
```

3. Fill the field and continue:

```ts
const response = await request.post("http://localhost:8000/api/otp-accounts/code", {
  data: { login: "qa-admin" }
});
const otp = await response.json();
await page.getByLabel(/code|otp|verification/i).fill(otp.code);
```

Recommended pattern:

- keep the secrets file or server-side OTP account outside git;
- use the fresh code only at the moment the 2FA form is visible;
- save `auth_state.json` after successful login;
- reuse `storageState` for the rest of the crawl so most later actions do not need OTP again.

## API Surface

Main routes preserved in the TypeScript server:

- `GET /`
- `GET /projects/{project_id}`
- `GET /scenarios/{scenario_id}`
- `GET /scenarios/{scenario_id}/code`
- `GET /runs/{run_id}`
- `GET /api/projects`
- `GET /api/projects/{project_id}/environments`
- `GET /api/otp-accounts`
- `POST /api/otp-accounts`
- `POST /api/otp-accounts/code`
- `DELETE /api/otp-accounts/{login}`
- `GET /api/projects/{project_id}/scenarios`
- `POST /api/projects/{project_id}/folders`
- `POST /api/projects/{project_id}/folders/move`
- `DELETE /api/projects/{project_id}/folders`
- `POST /api/projects/{project_id}/scenarios/upload`
- `GET /api/scenarios/{scenario_id}`
- `GET /api/scenarios/{scenario_id}/download`
- `POST /api/scenarios/{scenario_id}/move`
- `DELETE /api/scenarios/{scenario_id}`
- `POST /api/scenarios/{scenario_id}/run`
- `DELETE /api/runs/{run_id}`
- `GET /api/runs/{run_id}`
- `GET /api/runs/{run_id}/artifacts`
- `GET /api/runs/{run_id}/artifacts/*`
- `GET /api/runs/{run_id}/stdout`
- `GET /api/runs/{run_id}/stderr`

## Quality Gates

Current local checks:

- `corepack pnpm run typecheck`
- `corepack pnpm test`
- `corepack pnpm run build`

These are already passing in the current workspace.

## Known Gaps

- Project state is JSON-backed today, not SQLite/Postgres
- Electron packaging into a distributable desktop app is not set up yet
- Full end-to-end smoke verification of agent record -> upload -> Docker run should still be completed on a real scenario before calling this production-ready

## Working Agreement

From this point on, treat `ts-playwright` as the main project:

- new runtime work should happen here
- new docs should live here
- new fixes should target TypeScript first
- the Python implementation should not be reintroduced as a runtime dependency
