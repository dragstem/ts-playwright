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
- npm 11+
- Docker Desktop or compatible Docker runtime for server-side runs
- Playwright browsers installed locally for agent recording and local replay

## Quick Start

```powershell
cd ts-playwright
npm install
npx playwright install chromium
npm run build
```

Start the server:

```powershell
node apps/server/dist/index.js
```

Start the agent in another terminal:

```powershell
npm run start -w @ts-playwright/agent
```

Server default URL: `http://localhost:8000`

## Development Commands

```powershell
npm run dev:server
npm run dev:agent
npm run typecheck
npm test
npm run build
```

Notes:

- `dev:server` runs the TypeScript server through `tsx watch`
- `dev:agent` starts the Electron app from built files
- `build` also copies static agent assets into `apps/agent/dist/assets`

## Configuration

### Server

Environment variables:

- `APP_HOST` - server host, default `0.0.0.0`
- `APP_PORT` - server port, default `8000`
- `APP_STORAGE_DIR` - storage directory, default `<project>/storage`
- `APP_API_KEY` - optional API protection via `X-API-KEY`
- `APP_OTP_AUTOREPLACE` - optional OTP autofill rewrite toggle, accepts `1/true/yes`

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

The template file is already included at [config.example.json](C:/Users/orochispam/Downloads/tron/playwright%20project/playwright-project2/ts-playwright/apps/agent/assets/config.example.json).

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
- runtime output capture into `outputs.json`
- optional auth state packaging and replay
- replacement of recorded base URL with runtime `BASE_URL`

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

- `npm run typecheck`
- `npm test`
- `npm run build`

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
