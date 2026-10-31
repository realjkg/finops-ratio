# R2 route inventory (base origin/main cf7c5d36e8e0bd5008e30586dd1a88c3eca06500)

Current auth as found on the base. "Required after R2" is the target in engagement mode (`RATIO_MODE=engagement`);
outside engagement mode (demo, simulation) behavior is unchanged. Machine token = `RATIO_API_TOKEN` through
`evaluateLiveDataAuth` + `withGateway`, tenant bound by `RATIO_API_TENANT_ID` (operator-only, never in a browser).
Session = Ratio's own server-managed named-user session (`__Host-ratio_engagement`, slice A2). PR = the slice:
A core identity directory + authorization service (this PR, no route yet); A2 session store + sign-in/out (local
bootstrap credentials) + CSRF + audit; B OIDC adapter (Authorization Code + PKCE; dependency decision pending);
C authorization on report/export/connector routes; D anonymous-path removal (`proxy.ts`); E operator commands.

| Path | Method | Data touched | Current auth | Required after R2 | PR |
|---|---|---|---|---|---|
| /api/v1/engagement/session | GET, POST, DELETE | users file, session store (new) | n/a (new) | POST: Origin + JSON + lockout, then password; GET/DELETE: session (+ Origin + CSRF on DELETE) | A2 |
| /api/v1/reports/engagement | GET | customer report (XLSX) | machine token | session with tenant + engagement + role check, or machine token; no-store; audit | C |
| /api/v1/reports/facts | GET | customer report facts (JSON) | machine token | same as above | C |
| /api/v1/costs/published | GET | customer published facts | machine token | same as above | C |
| (PDF report, not yet built) | GET | customer report (PDF) | n/a | same as above when it lands | C |
| /api/v1/connectors | GET | connector registry; live status and probe with token | gateway token outside local simulation (env-independent projection without it only in simulation); live status and `probe=true` need the live-data token | 404 in engagement mode | D |
| /api/v1/ai/chat | POST | LLM (mock or live) | gateway token (bypass only in local simulation) | 404 | D |
| /api/v1/cm/change | POST | change management | gateway token | 404 | D |
| /api/v1/a2a/handshake, /api/a2a/handshake | POST | FinIO peer handshake (simulation era) | gateway token, plus `X-FinIO-Peer-Token` when one is configured; unchanged by PR A | 404 | D |
| /api/v1/finio/export, /api/finio/export | GET | FinIO export (seed) | gateway token | 404 | D |
| /api/costsource/ingest | POST | parses an uploaded export (stateless) | ANONYMOUS | 404 (+ copy fix: no "live door") | D |
| /api/costsource/rows, findings, health | GET | seed sandbox rows; live sources with token | anonymous for sandbox ids, token otherwise | 404 | D |
| /api/costsource/sources | GET | source list | anonymous list, token for live | 404 | D |
| /api/attribution, /api/tokenomics | GET | seed figures | ANONYMOUS | 404 | D |
| /api/prediction/predict | POST | seed model | ANONYMOUS | 404 | D |
| /api/prediction/accuracy | GET | seed figures | ANONYMOUS | 404 | D |
| /api/report/snapshot | GET | seed report | ANONYMOUS | 404 | D |
| /api/hello | GET | static | ANONYMOUS | 404 | D |
| /api/v1/simulation/* (8 routes) | various | simulation SQLite | simulation session, only when simulation enabled | 404 | D |
| / , /overview, /workloads, /connectors, /costsource, /attribution, /prediction, /tokenomics, /frameworks, /reports, /outcomes, /mission, /agent-workflows, /finio, /finio/demo, /demo, /hello | GET | seed/demo figures (client bundles) | ANONYMOUS | 404 | D |
| /simulation, /workspace | GET | simulation UI | anonymous page; data behind simulation session | 404 | D |
| /signin, /engagement (report page) | GET | sign-in form; customer report page | n/a (not built) | later PR, behind the session; browser reporting stays disabled until R2 verifies | later |

Findings on the base: no `proxy.ts` (and no `middleware.ts`); every page is anonymous; `authorize()` is not called by
any route (defect 15); the machine-token routes answer 405 before auth only through `withGateway` after the live-data
check (report routes check auth first). No customer-data route is anonymous today; the anonymous routes serve seed or
parsed-in-request data, which would be misleading next to customer data, hence 404 in engagement mode (plan decision 3).

Existing authentication mechanisms (step 1 of the owner update): no OIDC, SAML or session library in package.json or
the lockfile (no next-auth, lucia, openid-client, jose, oauth4webapi); `src/mock/idp` is a dev/test-only Ed25519
token mock (gated by `RATIO_MOCK_IDP=1` with `RATIO_ENV` development/test), not federation; `src/identity` + `src/rbac`
are a persona contract with no route calling it; the simulation's hashed-token cookie sessions are the only working
browser session code. Federation therefore needs a maintained OIDC library (decision in the PR body).
