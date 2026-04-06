---
name: ts-playwright-browser-debug
description: Use when debugging local browser flows, capturing snapshots, or interactively inspecting the ts-playwright UI through the project-local Playwright MCP server.
---

# ts-playwright Browser Debug

Use this project-local skill when Codex needs a browser session against the local `ts-playwright` server.

## Required global skill

Open and follow the installed Codex skill at:

1. `~/.codex/skills/chrome-devtools/SKILL.md`

## Project-local setup

- Start the local server with `corepack pnpm run start:server`
- Use the Playwright MCP server `ts-playwright-browser`
- The MCP wrapper is `plugins/ts-playwright-codex/scripts/run-playwright-mcp.cmd`
- The browser session writes artifacts to `storage/playwright-mcp-output`

## Typical uses

- Inspect the local HTML UI at `http://localhost:8000`
- Capture screenshots or accessibility snapshots
- Reproduce browser-level issues before changing code
- Validate interactive flows after edits
