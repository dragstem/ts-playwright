# Site Discovery Document

Use this template for the final artifact unless the user asks for a different format.

## 1. Scope

- Starting URL:
- Environment:
- Auth / role used:
- Exploration date:
- Safe-mode limits:
- Output owner:

## 2. Coverage Summary

- Areas explored:
- Areas partially explored:
- Areas blocked or out of scope:
- Confidence level:

## 3. Navigation Map

| Node | Entry point | URL / route | Parent | Access needs | Notes |
| --- | --- | --- | --- | --- | --- |
| Home | Direct URL | `/` | Root | Anonymous | Landing page |

## 4. Screen Inventory

Repeat this section for every unique page, modal, drawer, tab set, or materially different in-place state.

### <Screen or State Name>

- URL / route pattern:
- Reached from:
- User purpose:
- Auth / role / feature flags:
- Key entities or data shown:
- Primary actions:
- Secondary actions:
- Observed states:
- Stable anchors or selectors:
- Risks or ambiguities:

## 5. Flow Inventory

Repeat for each meaningful user journey.

### <Flow Name>

- Goal:
- Start point:
- Preconditions:
- Steps:
- Variants:
- Success signals:
- Failure signals:
- Useful reusable actions:
- Data requirements:

## 6. Candidate Test Matrix

| ID | Priority | Flow / screen | Preconditions | Core assertions | Notes |
| --- | --- | --- | --- | --- | --- |
| T01 | High | Login | Valid account | User reaches dashboard | Core regression |

## 7. Reusable Actions

| Action name | Trigger / target | Inputs | Expected result | Notes |
| --- | --- | --- | --- | --- |
| open-login | Header "Sign in" | none | Login modal appears | Good page-object helper |

## 8. Data and Environment Needs

- Accounts or roles:
- Seed data:
- Feature flags:
- External integrations:
- File fixtures:

## 9. Gaps and Blockers

- Missing access:
- Broken flows:
- Unknown behavior:
- Destructive paths intentionally skipped:

## 10. Automation Handoff

- First tests to automate:
- Shared setup to implement:
- Selectors or page objects worth stabilizing:
- Follow-up exploration needed before full coverage:
