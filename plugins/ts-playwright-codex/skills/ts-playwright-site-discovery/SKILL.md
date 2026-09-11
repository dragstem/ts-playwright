---
name: ts-playwright-site-discovery
description: Use when the user wants Playwright MCP to start from a URL, explore the reachable site or app, walk nested navigation and interactive states, and produce a structured discovery document that can drive future test generation, action generation, or manual QA coverage.
---

# ts-playwright Site Discovery

Use this project-local skill to turn a starting URL into a reusable site map and automation handoff document.

## Required global skills

Open and follow these installed Codex skills from the default Codex skills directory:

1. `~/.codex/skills/chrome-devtools/SKILL.md`
2. `~/.codex/skills/playwright-regression-orchestrator/SKILL.md` only after the discovery document exists and you are turning findings into automated coverage

## Project-local tools

- Playwright MCP server: `ts-playwright-browser`
- MCP config: `codex/playwright-mcp.config.json`
- Local MCP wrapper: `plugins/ts-playwright-codex/scripts/run-playwright-mcp.cmd`
- Start the local app server with `corepack pnpm run start:server` when the target site is the repo UI at `http://localhost:8000`

## Workflow

### 1. Frame the discovery task

- Record the starting URL, environment, auth state, role, and any known guardrails.
- Default to safe exploration only. Do not trigger destructive, irreversible, or high-cost actions unless the user explicitly allows them.
- If the user does not give an output path, write the artifact to `codex/site-discovery/<site-slug>.md` so it remains versionable and easy to reuse.
- If credentials, feature flags, or seed data are missing, continue with the accessible surface and capture blockers explicitly.
- If a reachable flow requires TOTP-based 2FA, use either `getOtpCodeFromFile(login, "storage/totp-secrets.txt")` or the local server API `POST /api/accounts/code` for an account that already has `2fa_otp` configured, only when the 2FA form is visible, then continue exploration and prefer saving auth state for the remaining crawl.

### 2. Build an exploration queue

- Start with the landing page, then enqueue:
  - global navigation
  - sidebars and breadcrumbs
  - tabs, accordions, drawers, and modal launchers
  - search/filter/sort controls
  - pagination and "load more" patterns
  - cards, table rows, and detail drill-ins
  - settings sections, wizard steps, and nested subsections
- Track visited states as `URL + main heading + role + meaningful UI state`.
- Prefer breadth-first traversal to map the product surface before going deep into a single branch.
- Treat in-place state changes as separate states when they materially affect available actions, validation, or assertions.

### 3. Traverse the site safely

- Prefer accessibility snapshots over screenshots for routine inspection. Use screenshots only when layout is important.
- Open each safe branch and continue through reachable nested states until one of these is true:
  - the branch loops back to an already documented state
  - the branch requires unavailable access or data
  - the remaining controls are destructive or duplicative
- Use benign inputs when forms or filters must be exercised to reveal behavior.
- Record exact blockers when deeper exploration is impossible: missing auth, missing fixtures, captchas, cross-origin restrictions, broken links, or server errors.
- Use console and network inspection only when they reveal behavior that is not obvious from the UI alone.

### 4. Capture findings for each unique screen or state

For every discovered page, panel, dialog, or meaningful state, capture:

- URL or route pattern
- page or state name
- how it is reached
- purpose from a user perspective
- auth, role, or feature flag requirements
- key entities shown on the screen
- available actions and where each action leads
- validation, empty, loading, success, and error states observed or strongly implied
- downloads, uploads, external handoffs, or background jobs
- stable UI anchors or selectors when they are obvious and worth preserving

### 5. Synthesize a test-oriented discovery document

- Use `references/discovery-document-template.md` as the default structure.
- Use `references/exploration-checklist.md` as a completeness pass before you finalize.
- Make each flow traceable to the screens and states discovered during traversal.
- Separate confirmed behavior from inferred behavior. Label inferences clearly.
- End with an "Automation Handoff" section that names:
  - highest-value regression candidates
  - reusable actions or page-object style helpers
  - setup and data prerequisites
  - blockers, unknowns, and recommended next exploration steps

## Heuristics

- Favor meaningful user journeys over brute-force DOM clicking.
- Go deep on nested navigation, but compress repetitive data-driven variants into representative examples.
- Distinguish route changes from in-place state changes such as tabs, filters, drawers, and dialogs.
- Prefer documenting why a branch matters for automation over listing every control with no context.
- When the site is too large for a single pass, prioritize core journeys first and leave a clearly marked backlog of unvisited branches.

## Deliverable

Produce a concise but structured Markdown document that another Codex instance can immediately use to generate Playwright tests or browser action sequences.

The document should let a downstream agent answer these questions without re-exploring the site:

- what screens and flows exist
- how they connect
- which states and assertions matter
- what setup is required
- what actions are reusable
- where the current knowledge is incomplete
