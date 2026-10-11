# Frank with an allowlisted, read-only MCP: evidence

Companion to [DESIGN.md](DESIGN.md). It records what the author checked, how,
and what could not be checked. Base: `origin/main` at 62bd8ed (merge of #93) when the citations were checked; the base is now 8caec87 (merge of PR #96), which touches only `docs/design/frank-mcp`, so the citations are unchanged.
Nothing here was run against a live model, a live MCP server or a database;
every code claim was verified by reading the file at that commit.

## 1. Method

- Fresh clone of `https://github.com/realjkg/finops-ratio`, `git fetch origin
  main`, branch `docs/frank-mcp-proposal` from `origin/main`.
- Files read in full or in the cited ranges: `pages/api/v1/ai/chat.ts`,
  `src/ai/{providers,AIClient,LiveAIClient,MockAIClient,index}.ts`,
  `src/agent-workflows/{frank,engine,types,policy}.ts`,
  `docs/evidence/frank-coster-interface.md`,
  `src/costsource/{PointFiveMcpTransport,CostSourceClient}.ts` and the
  `redact.ts` header and rules, `src/server/gateway/{auth,withGateway,liveDataAuth}.ts`,
  `src/server/costs/{publishedCostsRoute,readerLogin}.ts`, migrations 0001,
  0002 (grants) and 0004 (header and grants), `src/lib/{derive,modelCompare,
  forecast,valueEvidence}.ts`, `src/mission/adjustmentGate.ts`,
  `src/attribution/{AttributionClient,allocation}.ts`,
  `src/outcomes/{durable,types}.ts`, `scripts/governance/{README.md,
  risk-rules.json}`, and `docs/design/slice-3-5/{DESIGN,EVIDENCE}.md` (status
  header, decision log, open decisions, section 5.1, section 6 of the
  evidence file).
- Revision 2 addresses the challenger's review of c97852d (4 Medium, 6 Low);
  the citations it touched (`derive.ts:33-35`, `engine.ts:196`,
  `chat.ts:336-344`, `chatRoute.test.ts:150-154`, `LiveFinioClient.ts:5-11`)
  were re-read.
- Line numbers in DESIGN.md were re-checked with `grep -n` / `sed -n` after
  drafting; four ranges were corrected at that point.

## 2. Verified by reading (path:line in DESIGN.md)

| Claim | Where |
|---|---|
| Providers `claude, openai, mistral, qwen, openllm, mock`; unset or unknown is `mock`; OpenAI-compatible presets; `openllm` key optional | `src/ai/providers.ts:15`, `:39-44`, `:58-85` |
| Adapters send no tools and read text only | `pages/api/v1/ai/chat.ts:99-112`, `:133-145`, `:160-189` |
| `MAX_MESSAGES` 50, `MAX_INITIATIVES` 100, `MAX_TOKENS` 1024; non-streaming | `pages/api/v1/ai/chat.ts:43-45`, `:21` |
| System prompt built from a browser-supplied snapshot; handler ignores gateway tenant | `:258-321`, `:325-345`, `:362-366` |
| Live provider forces gateway auth; no token configured then 401 | `src/server/gateway/auth.ts:36-42`, `:88-95` |
| Browser client posts without Authorization | `src/ai/LiveAIClient.ts:17-21`; repo search for `Authorization`/`Bearer` found no browser-side adder |
| Simulation chat returns `provider: 'mock'` | `pages/api/v1/simulation/chat.ts:17` |
| Workflow Frank is deterministic | `src/agent-workflows/frank.ts:36-129`, `engine.ts:135-143`, `types.ts:13` |
| Authority statement | `src/agent-workflows/frank.ts:11-12` |
| "no credential discovery, MCP installation ..." | `docs/evidence/frank-coster-interface.md:19` |
| Only MCP code is PointFive scaffolding | grep for `mcp` (case-insensitive) in `*.ts, *.tsx, *.mjs, *.json, *.md`: `src/costsource/*`, `src/connectors/ConnectorCard.tsx`, design docs, the Frank evidence doc; `package.json` has no MCP package |
| Reader role is `SELECT`-only on published views; login check refuses writer-reachable logins | migration 0001:664-667; 0004:576-577; `readerLogin.ts:1-14` |
| Durable store entities | `CREATE TABLE`/`CREATE VIEW` listing of migrations 0001, 0002, 0004: tenants, sources, ingest bookkeeping, `cost_facts`, publications, billing scopes, fx rates, outcome tables and views. No workload, team or initiative table. Migration 0003 is absent from the directory. |
| `allocateSharedCost` has no non-test caller | `grep -rn allocateSharedCost src pages` excluding tests and `allocation.ts` returned nothing |
| Forecast and anomaly APIs are proposed | `docs/design/slice-3-5/DESIGN.md:2536-2548` ("proposed", Slices 3-5 not built); this branch's base has no `forecasts` route under `pages/api` |
| Redaction module functions | `src/costsource/transports/redact.ts:327`, `:371`, `:412` |

## 3. Searches whose negative result the design relies on

- No MCP server and no general MCP client: case-insensitive `mcp` across
  source, pages, scripts and manifests (list above).
- No tool calling: `tools`, `tool_use`, `tool_calls` do not appear in
  `pages/api/v1/ai/chat.ts` or `src/ai/`.
- No browser-side Authorization header for the chat route: search of `src/`
  and `pages/` for `Authorization` and `Bearer` outside tests, redaction,
  costsource, finio, ingest and the gateway.

These are searches, not proofs of absence in unread files; the base commit was
searched as a whole tree.

## 4. Could not be verified

| Item | Why |
|---|---|
| Any statement about the MCP specification (section 2.5 of DESIGN) | `WebFetch` to modelcontextprotocol.io failed with a DNS error (`ENOTFOUND`); `curl` through the proxy returned a 403 on the tunnel. No page or specification version was read. Every MCP-spec reliance is marked unverified in DESIGN. |
| Vendor tool-calling formats (Claude, OpenAI, OpenAI-compatible) | Not fetched; described from general knowledge and marked unverified. |
| OpenRouter or any named local server behaving as an OpenAI-compatible tool-calling endpoint | No access; the repo has no test for it. The `openllm` path is verified only as text chat by reading. |
| Any specific model's tool-calling quality | No model run; certification is a later milestone. |
| In-app live chat actually returning 401 | The author read the code (no header sent, auth enforced) and did not run it. The challenger reports running a vitest that stubbed `fetch` against the real chat handler with `AI_PROVIDER=openllm` and a strong `RATIO_API_TOKEN`: `LiveAIClient` sent only `Content-Type` and the call was rejected (reported, not re-run by the author). Corroboration read: `src/ai/chatRoute.test.ts:150-154`; `src/finio/LiveFinioClient.ts:5-11` (the browser intentionally omits Authorization). |
| The two origin statements ("Will Frank also work with a localized MCP and open router?", "Write up the allowlisted read-only MCP proposal first.") the relayed statement that MCP must be usable in dev, test and production under RBAC (DESIGN 3.8, OD-6), and the two relayed owner quotes ("Not replacing production with a prompt ..." and "FinOps and Governance is knowing when to stop.") and their exact date | Not in the repository; the source messages were not seen. The three other quotes are verbatim in `docs/design/slice-3-5/EVIDENCE.md` section 6. |
| Test suite status | Not run (docs-only change). |

## 5. Contradictions with what the owner was told

1. "OpenRouter and local model servers already work through
   `AI_PROVIDER=openllm`": true for the server route as a text-only chat path
   (by reading), but there is no OpenRouter preset or test, and the in-app
   browser client sends no Authorization header while a live provider forces
   auth, so the in-app live chat would be refused as far as the code reads.
2. "Frank has no tool calling": correct, and stronger: the workflow Frank is
   not model-driven at all (`deterministic-simulation-v1`).
3. Not a contradiction but relevant: the chat route's data is a
   browser-supplied snapshot, so even text-only live chat is not grounded in
   server-held tenant data.

## 6. Governance classification and rollback

Classifier result at the final head of revision 3 (re-run on the real diff
against `origin/main` at 8caec87): `risk: restricted`, class `retention` only,
rule `retention.mention`. On the first commit it fired on `DESIGN.md` (the
audit-retention discussion); at the revision 3 head it fires on the files
recorded in the pull request description and the report (this section's own
text contains the word, so `EVIDENCE.md` matches too). Recorded also in the pull request description (the classifier is run on the real diff, `node scripts/governance/classify-risk.mjs
--git origin/main...HEAD`; the result is reported as it came out, and the
wording of these documents was not shaped to avoid any rule).
