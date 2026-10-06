# Frank Coster interface

Frank Coster is Ratio’s FinOps accountability partner. His persona is calm, candid and precise: explain the evidence, name the owner, and make the next step clear. He is an agent identity, not a claim of human financial review.

## Interface

The guided workspace at `/agent-workflows` contains initiative selection, evidence-grounded questions, source-revision disclosure, a four-part readiness path, a saved proposal and role-specific tasks, independent human review rationale, and a visible authority panel. Operational controls remain in a disclosure beneath the workspace. The global drawer is named Frank Coster and links to this workspace; outcome-related simulation questions use the same saved evidence evaluator.

The four steps are owner/baseline, value evidence, full cost, and decision/governance. Recorded inputs are not presented as verified causal outcomes. Assumed and projected financial value remain separate from measured reviewed benefit. Unknown cost categories remain unknown. Expansion recommendations require full outcome evidence and governance; decisions use the existing validated commands.

## Bounded tool

`review-with-frank` is authorized for all three simulation personas because it only evaluates saved evidence and drafts review tasks. It invokes the existing queue/lease/process state machine in one atomic storage command, using the authenticated user as requester and Frank as the simulated processor. Internal processing actions are audited separately. It does not grant those personas Technical authority for general job controls. Identical input snapshots reuse prior jobs; interrupted jobs still use the existing recovery workflow.

Acceptance requires an independent Executive/Procurement reviewer, rationale, and a current input fingerprint. It records review only. Business decisions and financial verification retain their original permissions and evidence validation.

## Agent operations boundaries

The authority panel exposes tenant/initiative scope, allowed evidence/review tools, and excluded provider credentials, external messages and cloud actions. No credential discovery, MCP installation, endpoint monitoring or security-vendor integration was added. The supplied endpoint-security context informs explicit authority and blast-radius visibility; its market statistics were not used as verified product requirements.

The dedicated question endpoint derives all inputs from the authenticated tenant workspace; client-submitted workspace/actor/answer data is never authoritative. Questions are read-only, bounded in length, protected by session/origin/CSRF controls and rate limits. A question cannot trigger execution or approve a claim. Responses identify their saved revision, and the interface flags changed workspace revisions. Question/answer UI state is transient and resets when tenant/initiative context changes; persisted reviews and audit history survive reload.

The simulation engine is deterministic, without external model inference or live provider actions. The live chat identity shares Frank’s persona, but that chat does not acquire workflow execution authority. Real identity/provider testing remains the later dev gate.

Validation: 52 focused tests across 10 files passed. All 7 built-app browser workflows passed, including independent approval, request boundary checks, persisted review, drawer access and mobile overflow checks. Desktop and mobile screenshots were inspected. Lint, typecheck and Next build passed. Bundle isolation found no problems (127 client files / 119 server files). Full unit validation passed 2,648 tests and retained four existing process-group cleanup failures in `scripts/local/local.test.mjs`. Real account authentication, live model/tool execution and customer release validation remain pending.
