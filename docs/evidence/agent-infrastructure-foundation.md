# Agent workflow infrastructure foundation

This is a local, persistent simulation foundation. It is not a production release or a claim of well-architected certification. The existing ingestion backend remains separate; no personal or customer credentials are required.

## Implemented controls

| Architectural concern | Executable foundation | Release prerequisite |
|---|---|---|
| Operational excellence | Tenant diagnostics, request correlation IDs, structured timing/status logs, audited transitions, visible failed jobs and stale proposals | Central log collection, alert routing, operational owner and measured service objectives |
| Security | Existing opaque sessions, CSRF/origin and role enforcement; independent proposal review; tenant-local job lookup; processor lease ownership; private snapshots; container non-root, read-only, dropped capabilities and loopback binding | Real OIDC identity and tenant claims, secrets manager, transport/egress policy, security review and RBAC refinement |
| Reliability | Atomic SQLite commands, optimistic concurrency, command idempotency, input deduplication, 60-second recoverable leases, three-attempt ceiling, consistent backups, verified restore to a new destination and session invalidation | Managed durable storage, HA/failover, backup retention and encryption, scheduled restore drills and measured RPO/RTO |
| Performance efficiency | Bounded 10-job worker drains, 100-job tenant history ceiling, integer financial math, persisted fixed-window tenant rate limits, 30-second client deadlines | Load tests with target volume, indexed normalized queue and storage strategy, measured concurrency and latency |
| Cost optimization | Zero inference calls in simulation, reused reviews for identical evidence, bounded attempts, no external actions; financial decisions retain evidence/full-cost thresholds | Meter real agent tokens, infrastructure and oversight; enforce provider budgets before a live executor |
| Sustainability | Deterministic local evaluation, no idle agent polling, bounded scheduled drains and duplicate suppression | Measure production resource use, right-size compute, select retention and scheduling policy |

## Workflow and authority

Any authenticated simulation persona queues an initiative review. A Technical identity or dedicated simulated worker claims a lease and processes the saved evidence. The deterministic engine invokes the same outcome evaluator used by UI/reporting; it creates a recommendation and role-specific tasks. It never accepts arbitrary model output, verifies evidence, changes budgets, writes business decisions, or calls cloud APIs.

Executive or Procurement can accept/dismiss a proposal with rationale, provided they are a different person from the requester. Acceptance checks the current baseline, costs, financial evidence and governance against the input fingerprint. Acceptance records review only. People complete evidence and decisions through existing validated outcome commands. Evidence references are metadata, not fetched or independently authenticated documents.

Queue identical evidence reuses the existing job, including closed jobs. Changed evidence permits a new review. A failed job can be requeued below three attempts. Expired running jobs can be reclaimed below that limit. An exhausted job remains visible for human dismissal; it does not silently disappear. The 100-job cap preserves audit history instead of truncating it. There is no autonomous workload mutation.

## Run locally

Start `npm run simulation:start`, choose an identity, then open **Customer workflow → Open agent workflows**. Queue, claim, interrupt, retry and process a job. Switch to a different Executive/Procurement identity and review it. Read authenticated JSON diagnostics at `/api/v1/simulation/operations`.

Run a bounded dedicated worker against the same database:

```sh
RATIO_ENV=development RATIO_SIMULATION=1 RATIO_WORKER_TENANT=acme npm run simulation:worker
```

The worker processes up to ten queued/expired jobs once, then exits. Schedule repeat invocations in the selected hosting environment later. It does not hold a browser session or load model credentials. Request limits are shared across local connections; the fixed-window implementation is a simulation foundation, not a distributed production gateway.

Optional single-host containers:

```sh
docker compose -f infrastructure/simulation/compose.yaml up --build -d web
docker compose -f infrastructure/simulation/compose.yaml --profile jobs run --rm worker
```

Only loopback publishes the app. The internal network denies ordinary container internet access. The named volume stores SQLite. Never expose this mock-identity deployment to customers. Docker runtime/network restrictions and image build require Docker validation in dev; they have not been exercised in this execution environment. The image is for simulation and includes development tooling; it is not a hardened production distribution.

## Backup and restore procedure

```sh
npm run simulation:storage -- backup .ratio-simulation/customer.sqlite /tmp/ratio-backup.sqlite
npm run simulation:storage -- restore /tmp/ratio-backup.sqlite /tmp/ratio-restored.sqlite
RATIO_SIMULATION_DB=/tmp/ratio-restored.sqlite npm run simulation:start
```

Choose a new destination for each snapshot/restore. Backup uses SQLite `VACUUM INTO` to capture an open WAL database consistently. Integrity and supported workspace shape are checked. Backup/restore invalidate sessions; command idempotency and audit history remain. Restore refuses active WAL sources and overwrites. Backups contain financial evidence, user names and audit metadata; keep them in access-controlled storage and apply encrypted retention before live data use. Do not copy the active database file with ordinary filesystem tools. Restore checks are structural, not a full hostile-file importer.

## Validation scope

Automated checks cover role boundaries, foreign-tenant jobs, lease forgery/expiry/reclaim, bounded interruption recovery, stale inputs, deduplication, unchanged financial/workload records, independent review, shared rate limits, an open-WAL backup and restored command/session semantics. Browser acceptance covers interruption/retry, persisted state, cross-persona review, operational diagnostics and tenant isolation. Real authentication, provider data, distributed queue/HA, cloud infrastructure and customer release validation remain separate gates.

Validation on this change: 27 focused tests across 8 files passed; all 6 built-app browser workflows passed, including mobile overflow checks; lint, typecheck and Next build passed; bundle isolation check found no problems (127 client files / 117 server files). The full unit suite passed 2,645 tests and retained four pre-existing process-group cleanup failures in `scripts/local/local.test.mjs`. Docker is unavailable here, so container execution is explicitly unverified.
