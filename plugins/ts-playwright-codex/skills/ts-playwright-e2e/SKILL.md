---
name: ts-playwright-e2e
description: Use when the user wants Playwright regression planning, spec generation, rerun loops, or end-to-end automation for this repository. This skill routes Codex to the installed Playwright skills in ~/.codex/skills and the project-local Playwright MCP server.
---

# ts-playwright E2E

Use this project-local skill for Playwright testing work inside the `ts-playwright` repository.

## Required global skills

Open and follow these installed Codex skills from the default Codex skills directory:

1. `~/.codex/skills/playwright-regression-orchestrator/SKILL.md`
2. `~/.codex/skills/chrome-devtools/SKILL.md` when browser debugging or screenshots are needed

## Project-local tools

- Playwright MCP server: `ts-playwright-browser`
- MCP config: `codex/playwright-mcp.config.json`
- Server start command: `corepack pnpm run start:server`
- Agent start command: `corepack pnpm run start:agent`

## Validation commands

- `corepack pnpm run typecheck`
- `corepack pnpm test`
- `corepack pnpm run build`

## Repo notes

- The browser-facing UI is served from `apps/server`.
- The Electron recorder lives under `apps/agent`.
- Shared runtime logic lives under `packages/shared` and `packages/runner`.
- Keep Playwright-facing documentation and automation config inside this repo instead of external project-specific folders.
