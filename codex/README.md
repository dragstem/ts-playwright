# Codex + Playwright MCP

This repository includes a project-local Codex integration for Playwright work.

## What Is Included

- `AGENTS.md` with project guidance for Codex
- `.agents/plugins/marketplace.json` with a local plugin entry
- `plugins/ts-playwright-codex/` with project-local Codex plugin metadata
- `codex/playwright-mcp.config.json` with a generic Playwright MCP config for this repo

## Local Playwright MCP

The plugin starts Playwright MCP through:

- `plugins/ts-playwright-codex/scripts/run-playwright-mcp.cmd`

That wrapper expects:

- Node.js 22+ to be available on `PATH`
- the Playwright MCP package to exist at `~/.codex/playwright-mcp-package`

The wrapper changes into the repo root before launching MCP, so the config can safely use repo-relative paths such as `./storage/playwright-mcp-output`.

## Installed Global Skills

The project plugin does not duplicate the full Codex Playwright skills. Instead, it points Codex at the already installed global skills under `~/.codex/skills/`:

- `playwright-regression-orchestrator`
- `chrome-devtools`

The local wrapper skills are:

- `ts-playwright-e2e`
- `ts-playwright-browser-debug`
- `ts-playwright-site-discovery`

## Expected Flow

1. Start the repo server with `corepack pnpm run start:server`.
2. Open Codex in this repo.
3. Use the project-local Playwright MCP server `ts-playwright-browser`.
4. For E2E planning or generation, invoke `ts-playwright-e2e`.
5. For browser debugging, invoke `ts-playwright-browser-debug`.
6. For deep site exploration and a reusable test-discovery document, invoke `ts-playwright-site-discovery`.
