---
name: local-dev
description: Start and validate the local Ratio Next.js frontend in the finops-ratio repo.
version: 1.0.0
triggers:
  - local dev
  - start ratio
  - next dev server
  - token-sensei setup
author: autobuild-setup-worker
created: 2026-06-25
---

# Local Dev — Ratio (`realjkg/finops-ratio`)

## Prerequisites

- Node.js v20.20.2 was verified in the setup sandbox with `node --version`.
- npm v10.8.2 was verified with `npm --version`.
- Package manager: npm, selected from `package-lock.json`.
- No Docker services, databases, queues, auth provider, or required backend are needed for Phase 1 local development.
- Optional environment variable: `NEXT_PUBLIC_ANTHROPIC_API_KEY`. Leave it empty to use the default data-grounded mock agent.

## Install

Run from the repository root:

```bash
npm install
```

This command completed successfully during setup.

## Environment Setup

No `.env` file is required for the demo-ready app.

Optional live-agent mode:

```bash
cp .env.example .env.local
# Then set NEXT_PUBLIC_ANTHROPIC_API_KEY if live Claude responses are needed.
```

If `NEXT_PUBLIC_ANTHROPIC_API_KEY` is unset, the app still works fully using `MockAgentClient`.

## Start Commands

Run from the repository root:

```bash
npm run dev
```

The setup run observed Next.js serving on:

```text
http://localhost:3000/
```

If port 3000 is busy, Next.js may select another port. Use the URL printed by stdout.

## Primary Flow Verified

Verified on 2026-06-25 against commit `4e836816236ba784c76e39df2c116efe8685a867`:

1. Installed dependencies with `npm install`.
2. Started the dev server with `npm run dev`.
3. Opened `http://localhost:3000/`.
4. Confirmed the 3-panel Ratio UI loaded.
5. Confirmed the left workload list rendered with value-ratio bars.
6. Confirmed a workload detail view rendered with the Budget Profile tab, KPI cards, forecast/budget bar, and center detail panel.
7. Confirmed Multi-Model Comparison tab rendered.

Evidence promoted during setup:

- `.obvious-install/screenshots/primary-flow/01-landing.png` — Ratio 3-panel layout and workload list — file: `fl_kxL5hCHS`
- `.obvious-install/screenshots/primary-flow/02-workload-selected.png` — workload selected, detail center panel — file: `fl_4TBpTXKm`
- `.obvious-install/screenshots/primary-flow/03-budget-profile-tab.png` — Budget Profile tab with forecast — file: `fl_nco8AYpn`
- `.obvious-install/screenshots/primary-flow/04-multi-model-tab.png` — Multi-Model Comparison tab — file: `fl_LIrrGV2p`

## Verification Commands

Verified commands:

```bash
npm run lint
npm run build
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```

Notes:

- `npm run lint` succeeded.
- `npm run build` succeeded.
- `npm run typecheck` exists and maps to `tsc --noEmit`, but it was intentionally not run in this sandbox per setup instructions.
- No test runner or test script is configured in `package.json`; do not invent a test command.

## Snapshot

- Snapshot ID: `icprr1z3f69clbt3lrls:default`
- Captured: 2026-06-25T18:25:27.651Z
- Dev stack healthy at capture: true

## Known Blockers

None for the verified local demo flow.

Non-fatal notes:

- `shot-scraper` and Playwright browser dependencies were installed in the setup sandbox to capture evidence. They are not repo dependencies.
- The security onboarding tool was unavailable in this worker toolset, so no async security scan was queued.
