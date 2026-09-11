# ts-playwright

Standalone TypeScript implementation of the Playwright recording and execution system.

Use this directory as an independent project root. The legacy Python code in the parent folder is no longer required for runtime and should be treated only as historical reference while migration tails are being closed.

## What This Project Contains

- `apps/server` - Fastify server with API and minimal HTML UI for projects, scenarios, runs, folders, server accounts, merchants, artifacts, stdout and stderr.
- `apps/agent` - Electron desktop agent for recording, previewing, replaying and uploading `Playwright Test` scenarios.
- `packages/shared` - shared schemas, placeholder helpers, OTP/TOTP logic, metadata builders and storage helpers.
- `packages/runner` - scenario source preparation, local replay helpers and Docker-based server execution.

## Current Runtime Model

- Scenarios are stored as TypeScript Playwright Test files: `scenario.spec.ts`
- Each package also contains `metadata.json`
- Optional auth state is stored as `auth_state.json`
- Server-side execution uses Docker and a pinned Playwright image
- Local replay uses the same TypeScript runtime path instead of Python
- Local UI/runtime state is stored in `storage/app-state.json`
- Scenarios are auto-discovered from committed `storage/projects/**/package.zip` files

## Requirements

- Node.js 22+
- pnpm 10+ via Corepack
- Docker Desktop with Linux containers enabled, or another compatible Docker runtime
- Playwright browsers installed locally for agent recording and local replay

## First Server Run On A Clean PC

This repository already includes committed demo scenarios under `storage/projects/proj_demo`, including a smoke scenario that can be executed from the server UI without recording a new test first.

Goal of this path: start from a clean machine, open the server, click `Run`, and see Docker Desktop create the Playwright runner container.

Server-side runs use the Docker image `mcr.microsoft.com/playwright:v1.52.0-jammy` by default. CI also publishes a small runner image from `Dockerfile.runner`; it contains the same pinned Playwright runtime plus a globally installed Playwright CLI for faster, more predictable server-side execution.

Before starting the server, make sure Docker Desktop is installed, switched to Linux containers, and fully started. Server-side execution depends on Docker, so without it the server may start but `run` jobs will fail.

Recommended clean-PC sequence from repo root:

1. Install Node.js 22+ and Docker Desktop.
2. Open Docker Desktop and wait until the engine is running.
3. Open a terminal in this repository root.
4. Run these commands in order:

```powershell
corepack pnpm install
docker version
docker pull mcr.microsoft.com/playwright:v1.52.0-jammy
corepack pnpm run build:server
corepack pnpm run build:web
corepack pnpm run start:server
```

If `corepack enable pnpm` fails on Windows with `EPERM` under `C:\Program Files\nodejs`, use `corepack pnpm ...` directly instead of enabling the global shim.

Why `docker pull` is included here:

- it removes the long silent wait on the first `Run`
- it makes Docker/image problems visible before the server UI is opened
- it guarantees the required Playwright runtime image is already cached locally

What each command does:

- `corepack pnpm install` installs workspace dependencies
- `docker version` confirms that the Docker CLI can talk to the Docker daemon
- `docker pull mcr.microsoft.com/playwright:v1.52.0-jammy` downloads the Playwright runner image used by server-side runs
- `corepack pnpm run build:server` builds `packages/shared`, `packages/runner`, and `apps/server`
- `corepack pnpm run start:server` starts the server on `http://localhost:8000`

Then:

1. Open `http://localhost:8000`
2. Open `Demo Project`
3. Open the `Smoke` folder
4. Run the `Example Domain smoke` scenario

What to expect on the first run:

- If you skipped the manual `docker pull` step above, Docker Desktop will pull the default Playwright image automatically on the first run
- a temporary runner container will appear in Docker Desktop
- the run may take longer the first time because the image is being downloaded
- the run page now shows Docker progress and errors in the execution log and live stdout/stderr preview

This minimal server-side path does not require:

- `corepack pnpm run playwright:install`
- `corepack pnpm run start:agent`
- building this repository's `Dockerfile`

The repo `Dockerfile` is only needed when you want to run the server itself inside a container.
`Dockerfile.runner` is only needed when you want to build your own scenario runner image instead of using the default Microsoft Playwright image.

## Full Local Setup

Use this path when you also want the Electron agent for recording, previewing, and uploading scenarios.

```powershell
corepack pnpm install
corepack pnpm run playwright:install
corepack pnpm run build
```

Start the server:

```powershell
corepack pnpm run start:server
```

Start the agent in another terminal:

```powershell
corepack pnpm run start:agent
```

`start:agent` now builds the Electron app before launch, so it works from a clean checkout without a separate agent build step.

If you want to run the server itself as a container, build the image first:

```powershell
docker build -t ts-playwright-server -f Dockerfile .
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
- `APP_DOCKER_RUNNER_MODE` - `npx` or `global`, default `npx`; use `global` with `Dockerfile.runner` images
- `APP_DOCKER_WORKSPACE_TRANSPORT` - `auto`, `bind`, or `copy`, default `auto`; `copy` is useful when the server itself runs in Docker and talks to the host Docker socket
- `APP_DOCKER_SHM_SIZE` - Docker `--shm-size` for runner containers, default `1g`; set `0`, `false`, `none`, or `off` to disable
- `APP_DOCKER_IPC` - optional Docker `--ipc` value, for example `host` on trusted Linux hosts
- `APP_DOCKER_NETWORK` - optional Docker `--network` value for runner containers
- `APP_DOCKER_ADD_HOSTS` - optional comma-separated Docker `--add-host` entries
- `APP_RUN_TIMEOUT_MS` - optional run timeout in milliseconds, default `900000`
- `APP_PLAYWRIGHT_DEFAULT_TIMEOUT_MS` - optional Playwright action/default timeout for prepared scenarios, for example `60000`
- `APP_ACCOUNTS_JSON` - optional JSON array of seeded server accounts
- `APP_MERCHANTS_JSON` - optional JSON array of seeded merchants
- `APP_POOLS_JSON` - optional JSON array of seeded runtime pools
- `APP_POOL_ITEMS_JSON` - optional JSON array of seeded runtime pool items

Example seeded entities:

```text
APP_ACCOUNTS_JSON=[{"login":"server-user","password":"secret-pass","2fa_otp":"JBSWY3DPEHPK3PXP"}]
APP_MERCHANTS_JSON=[{"name":"demo-merchant","admin_login":"server-user","env_ids":["staging"]}]
APP_POOLS_JSON=[{"id":"trace-default","name":"Default trace IDs","kind":"trace_id","allocation_strategy":"template","template":"{date}_{testName}_{seq}"}]
APP_POOL_ITEMS_JSON=[{"id":"addr-1","pool_id":"usdt-payouts","value":"TExampleAddress","currency":"USDT","network":"TRC20"}]
```

Startup behavior:

- entities from `APP_*_JSON` are imported into `storage/app-state.json` when they are missing
- after import they remain editable from the server UI/API
- if a record exists both in env seed and in server state, the server state version wins
- legacy `APP_OTP_ACCOUNTS_JSON` values are auto-migrated into matching account `2fa_otp` secrets when present during startup
- runtime pools and pool items are managed from `/cabinet`; run outputs can be promoted into pools from the run details page
- field-level cabinet documentation lives in [docs/runtime-cabinet.md](docs/runtime-cabinet.md)

Scenario execution behavior:

- prepared scenarios now wait for the app shell after `page.goto(...)` and wait for GraphQL activity to become idle after recorded click/press actions
- the desktop recorder treats stable HTML `id` attributes as Playwright test IDs, so generated locators can use `getByTestId(...)`
- GraphQL observations are saved to `graphql-report.json` in run artifacts
- codegen advisories are saved to `codegen-diagnostics.json`; they call out brittle generated locators such as empty labels, positional locators, and double-clicks without blocking the run
- Docker runs fail early when a required `server_*` runtime input is still referenced by the prepared scenario but is absent from server inputs/secrets

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

## Git Tracking

Scenario packages under `storage/projects/**/package.zip` are intended to be committed so folder structure and scenarios can live in GitLab.

Tracked on purpose:

- `storage/accounts.json`
- `storage/merchants.json`

Ignored on purpose:

- `storage/app-state.json`
- `storage/**/runs/**`
- other local runtime-only storage files

That means scenarios, server accounts, and merchants can be restored from Git without committing run history or run artifacts.

## Scenario Features

Supported business logic in the TypeScript version:

- input placeholders like `{{INPUT:user_name}}`
- OTP placeholders like `{{INPUT:2fa_otp}}`
- account-based 2FA secrets via `accounts[].2fa_otp`
- batch runs for one or many folders with one consolidated input form
- execution stages for batch runs: same stage runs in parallel, next stage waits sequentially
- runtime pools for trace IDs, deposit addresses, payout addresses and custom values
- run runtime snapshots so retry uses the same trace ID, selected pool values, account and merchant data
- merchant presets can be linked to an admin account; the admin account supplies OTP/TOTP at run time
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

If you prefer keeping secrets in the local server state, store them directly on the server account and request a live code only when the 2FA form appears.

1. Save a server account with `2fa_otp` configured:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/accounts -ContentType 'application/json' -Body '{"login":"qa-admin","password":"secret-pass","2fa_otp":"JBSWY3DPEHPK3PXP"}'
```

2. When the Playwright flow reaches a 2FA challenge, request a fresh code:

```powershell
$otp = Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/accounts/code -ContentType 'application/json' -Body '{"login":"qa-admin"}'
$otp.code
```

3. Fill the field and continue:

```ts
const response = await request.post("http://localhost:8000/api/accounts/code", {
  data: { login: "qa-admin" }
});
const otp = await response.json();
await page.getByLabel(/code|otp|verification/i).fill(otp.code);
```

Recommended pattern:

- keep the secrets file or server-side account config outside git;
- use the fresh code only at the moment the 2FA form is visible;
- save `auth_state.json` after successful login;
- reuse `storageState` for the rest of the crawl so most later actions do not need OTP again.

## API Surface

Main routes preserved in the TypeScript server:

- `GET /`
- `GET /projects/{project_id}`
- `GET /runs`
- `GET /scenarios/{scenario_id}`
- `GET /scenarios/{scenario_id}/code`
- `GET /runs/{run_id}`
- `GET /api/projects`
- `GET /api/runs`
- `GET /api/projects/{project_id}/environments`
- `GET /api/accounts`
- `POST /api/accounts`
- `POST /api/accounts/code`
- `DELETE /api/accounts/{login}`
- `GET /api/merchants`
- `POST /api/merchants`
- `DELETE /api/merchants/{name}`
- `GET /api/pools`
- `POST /api/pools`
- `DELETE /api/pools/{pool_id}`
- `GET /api/pools/{pool_id}/items`
- `POST /api/pools/{pool_id}/items`
- `PATCH /api/pools/{pool_id}/items/{item_id}`
- `DELETE /api/pools/{pool_id}/items/{item_id}`
- `POST /api/pools/{pool_id}/fetch`
- `POST /api/pools/{pool_id}/import-run-outputs`
- `POST /api/runs/{run_id}/outputs/{output_key}/add-to-pool`
- `GET /api/projects/{project_id}/scenarios`
- `POST /api/projects/{project_id}/folder-runs`
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

For server-only CI and container builds, this repo also exposes:

- `corepack pnpm run typecheck:server`
- `corepack pnpm run build:server`

These are already passing in the current workspace.

## GitLab Deployment

This repo now includes a GitLab-ready delivery path for the server runtime:

- `.gitlab-ci.yml` runs validation, builds a server container, and pushes it to the GitLab Container Registry
- `Dockerfile` builds only the server-side workspace packages, without requiring the Electron agent at runtime
- `Dockerfile.runner` builds the pinned Playwright runner image used by deployed server-side runs
- `deploy/docker-compose.gitlab.yml` starts the published image on a Docker host and mounts `/var/run/docker.sock` so scenario execution can still launch Playwright containers

### Pipeline behavior

- `validate` runs `typecheck:server`, `test`, and `build:server`
- `package:server` publishes `server:<short_sha>` and `server:<branch_slug>`
- `package:server` also publishes `runner:<short_sha>` and `runner:<branch_slug>`
- default branch also publishes `server:latest`
- default branch also publishes `runner:latest`
- `deploy:server` is a manual production job and appears only when the required SSH variables are configured in GitLab CI/CD settings

### Required GitLab variables for manual deploy

- `DEPLOY_HOST` - Docker host or VM hostname
- `DEPLOY_USER` - SSH user on the target host
- `DEPLOY_PATH` - remote directory where `docker-compose.yml` and `.env` should live
- `DEPLOY_SSH_PRIVATE_KEY` - private key used by the deploy job

Optional deploy variables:

- `DEPLOY_REGISTRY_USER`
- `DEPLOY_REGISTRY_PASSWORD`
- `DEPLOY_APP_PORT`
- `DEPLOY_APP_API_KEY`
- `DEPLOY_APP_OTP_AUTOREPLACE`
- `DEPLOY_APP_RUN_TIMEOUT_MS`
- `DEPLOY_APP_DOCKER_IMAGE`
- `DEPLOY_APP_DOCKER_RUNNER_MODE`
- `DEPLOY_APP_DOCKER_WORKSPACE_TRANSPORT`
- `DEPLOY_APP_DOCKER_SHM_SIZE`
- `DEPLOY_APP_DOCKER_IPC`
- `DEPLOY_APP_DOCKER_NETWORK`
- `DEPLOY_APP_DOCKER_ADD_HOSTS`
- `DEPLOY_APP_PLAYWRIGHT_DEFAULT_TIMEOUT_MS`

If `DEPLOY_REGISTRY_USER` and `DEPLOY_REGISTRY_PASSWORD` are not set, the deploy job falls back to GitLab's job-scoped registry credentials.

### Target host requirements

- Docker Engine with `docker compose`
- access to pull from the GitLab Container Registry
- writable directory at `DEPLOY_PATH`

You can preview the runtime env shape locally with [deploy/server.env.example](deploy/server.env.example).

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
