# Frank with an allowlisted, read-only MCP: evidence

Companion to [DESIGN.md](DESIGN.md). It records what the author checked, how,
and what could not be checked. Base: `origin/main` at 62bd8ed (merge of #93)
when the citations were checked; the base is now 8caec87 (merge of PR #96),
which touches only `docs/design/frank-mcp`, so the citations are unchanged.
Nothing here was run against a live model, a live MCP server or a database;
every code claim was verified by reading the file at that commit.

Review history, as in DESIGN.md: revision 1 (c97852d, PR #96) was reviewed by
a challenger (changes requested); revision 2 (6402ab3, 00523cf) answered it
and a second challenger review of PR #98 requested changes; revision 3
(e050578, d997618) answered that and the round-3 challenger approved it;
Copilot then reviewed d997618 and revision 4 (52de3cf) answered it; a round-4
challenger review requested changes and 16581c8 answered it; revision 5
(1ffb5fd) answered Copilot's next review and the round-5 challenger's review of
16581c8; revision 6 (473aed0) answered the round-6 challenger's review of
1ffb5fd and revision 7 (6f4c9f7) updated the review history; revision 8
(6f82d26) answered the round-7 challenger's review of 6f4c9f7; revision 9
(911b67c) answered the round-8 challenger's review of 6f82d26; revision 10
(90eee59) answered the round-9 challenger's review of 911b67c, with a splice
error in DESIGN.md that revision 11 repairs; revision 11 answers the round-10
challenger's review of 90eee59.

## 1. Method

- Fresh clone of `https://github.com/realjkg/finops-ratio`, `git fetch origin
  main`, branch `docs/frank-mcp-proposal` from `origin/main`.
- Files read in full or in the cited ranges: `pages/api/v1/ai/chat.ts`,
  `src/ai/{providers,AIClient,LiveAIClient,MockAIClient,index}.ts`,
  `src/agent-workflows/{frank,engine,types,policy}.ts`,
  `docs/evidence/frank-coster-interface.md`,
  `src/costsource/{PointFiveMcpTransport,CostSourceClient}.ts` and the
  `redact.ts` header and rules,
  `src/server/gateway/{auth,withGateway,liveDataAuth}.ts`,
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
- Revision 3 sources: the sprint plan
  `docs/design/sprint-mock-demo-mcp-rbac/PLAN.md`
  on branch `docs/sprint-plan-mock-demo-mcp-rbac` at 7a7d51b (lines 127,
  142-143, 160, 319), read for T-6; `src/lib/forecast.ts:118`.
- Revision 4 sources: `src/ingest/config.ts:11`, `:161`, `:178` (the
  `RATIO_ENV` vocabulary and the empty-value handling) and
  `src/costsource/transports/redact.ts:327-340` (the rules the result-value
  scan reuses; all re-read).
- Revision 5 sources: `src/ingest/config.ts:189-190` (an empty `RATIO_ENV`
  becomes `development` in `loadWorkerConfig`); the four redaction sample
  outputs were reproduced by running `applyRedactionRules` from
  `src/costsource/transports/redact.ts` on the base code with Node's type
  stripping.
- Revision 6 and 7 sources (reproductions by the author, running
  `applyRedactionRules` from `src/costsource/transports/redact.ts` on the base
  code with Node's type stripping):
  - `JSON.stringify({url:'https://example.com/a?x=1&y="2"', z:1})` redacts to
    `{"url":"https://example.com/a?[REDACTED]`, which does not parse (the URL
    rule's `?` tail runs to the end of the one-line serialized JSON);
  - `JSON.stringify({password:'abc def'})` redacts to
    `{"password":"[REDACTED]"}`, while the bare value `abc def` is unchanged
    (a key-only hit, so per-value redaction alone would leak it).
- Revision 8 and 9 sources: no new code or external sources. The changes are
  design rules (flip-detector initialization, the generation definition, case
  (m)), and the key table was reconciled with OD-8 and 3.3.
- Revision 10 sources: no new code or external sources. The per-request
  environment re-check was removed on the orchestrator's decision (a minor
  design decision); the evaluation rules, A20 and the key table were
  rewritten to match.
- Revision 11 sources: no new code or external sources. DESIGN.md was rebuilt
  from 911b67c plus the revision 10 edits (the 90eee59 splice came from a
  string search that matched an earlier occurrence); the diff 911b67c..HEAD
  was reviewed as a whole and the section and table checks below were run.
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
| The two origin statements ("Will Frank also work with a localized MCP and open router?", "Write up the allowlisted read-only MCP proposal first."), the relayed statement that MCP must be usable in dev, test and production under RBAC (DESIGN 3.8, OD-6), and the two relayed owner quotes ("Not replacing production with a prompt ..." and "FinOps and Governance is knowing when to stop.") and their exact date | Not in the repository; the source messages were not seen. The three other quotes are verbatim in `docs/design/slice-3-5/EVIDENCE.md` section 6. |
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

Classifier history on the real diff against `origin/main`: revision 1
(c97852d) was restricted, class `retention`, rule `retention.mention` on
`DESIGN.md`; revisions 2 and 3 were restricted for the same class and rule, on
`EVIDENCE.md` only at the end. At revision 4 the classifier was run twice:
before this paragraph was written the diff contained no rule match and the
result was `risk: low`; with a paragraph that names the rule, the result was
`risk: restricted`, class `retention`, rule `retention.mention`, on
`docs/design/frank-mcp/EVIDENCE.md` only. It was re-run at each later
revision. At revision 10 (90eee59) it reported both `DESIGN.md` and
`EVIDENCE.md`: that `DESIGN.md` was the spliced file, whose rewrapped
audit-retention sentence and decision-table row counted as added lines. At
revision 11, with `DESIGN.md` rebuilt from 911b67c, the classifier was re-run
at the final head and reports `risk: restricted`, class `retention`, rule
`retention.mention`, on `EVIDENCE.md` only (this section names the rule).
Neither result proves the change safe (the gate's own README calls `low`
heuristic). The classification is recorded in the pull request body at the
final head; this file makes no claim about the title or body of the pull
request beyond that. The wording of these documents was not shaped to avoid
any rule.

Rollback: revert the two documents; reverse-applying the diff to origin/main
gives the same tree as origin/main.
