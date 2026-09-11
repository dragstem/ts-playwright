# ts-playwright

## Project Focus

- This repository is the main TypeScript runtime for recording and executing Playwright Test scenarios.
- Prefer changes here over the legacy Python implementation in the parent folder.
- Runtime data under `storage/` is generated state and is already ignored by git.

## Main Commands

- Install dependencies: `corepack pnpm install`
- Install local browsers: `corepack pnpm run playwright:install`
- Start the server: `corepack pnpm run start:server`
- Start the agent: `corepack pnpm run start:agent`
- Typecheck: `corepack pnpm run typecheck`
- Test: `corepack pnpm test`
- Build: `corepack pnpm run build`

## Codex Integration

- This repo ships a local Codex plugin at `plugins/ts-playwright-codex`.
- The plugin exposes the project-local Playwright MCP server `ts-playwright-browser`.
- The MCP launcher lives at `plugins/ts-playwright-codex/scripts/run-playwright-mcp.cmd`.
- The repo-level Playwright MCP config lives at `codex/playwright-mcp.config.json`.

## Playwright Skills

- Use `ts-playwright-e2e` for Playwright suite design, generation, and rerun loops in this repo.
- Use `ts-playwright-browser-debug` for browser debugging, snapshots, and interactive inspection.
- Use `ts-playwright-site-discovery` to crawl from a starting URL, explore nested site functionality, and produce a test-oriented discovery document.
- These project skills route to the installed global Codex skills under `~/.codex/skills/`:
  - `playwright-regression-orchestrator`
  - `chrome-devtools`

## Working Style

- Keep changes aligned with the existing TypeScript monorepo layout under `apps/` and `packages/`.
- Prefer repo-local documentation and config over machine-specific notes.
- When browser automation is needed, start the local server first and then use the project MCP server instead of hard-coded external configs.
