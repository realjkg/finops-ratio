# Governed remediation with tiered autonomy (`src/remediation/`)

Checklist: Step 5, items 5.1 to 5.3, tests in 5.5. Pure, deterministic TypeScript.
There is no cloud execution in this build. The executor is an interface, and the only
implementation shipped is an in-memory test double.

## Design (written before the code)

1. The default posture is unchanged: propose, then a different person approves,
   then apply. This matches the "never auto-applied" rule of the adjustment gate
   (`src/mission/adjustmentGate.ts`). Autonomy is an opt-in exception, not a new default.
2. Autonomy is opt-in per tenant per action class and OFF by default. A tenant policy
   object lists the classes it enables, and nothing else. An empty, missing or malformed
   policy means "no autonomy". A policy can only name classes the registry marks
   autonomy-eligible; the policy parser refuses anything else.
3. Eligibility is structural, not a setting. An action may be autonomy-eligible only if
   it is low risk, reversible, and not a commitment purchase. This is enforced twice:
   by the `ActionDefinition` type (a high-risk or irreversible definition with
   `autonomyEligible: true` does not compile) and by a startup-time check
   (`buildRegistry` throws, and the default registry is built when the module loads).
   `decide` re-checks it, so a hand-built policy cannot override it either.
4. `decide(proposal, policy, state, now)` is a pure function that returns
   `auto_execute`, `require_approval` or `deny`, with a fixed reason code and the list
   of every gate that failed. Auto-execute needs every gate to pass at once. Anything
   short of a deny routes to a human.
5. The human path wraps `authorize()` from `src/rbac/authorize.ts` without changing it:
   `change.request`, then `change.approve` (the approver must differ from the requester,
   which `authorize()` enforces and this code asserts again), then `change.apply`.
   A wrong order or a missing approval is denied with the contract's statuses
   (401, 403, 409).
6. Execution is dry-run first, then execute, then a post-check. A reversible action
   records a rollback token. A failed execution with a token, or a failed post-check,
   rolls back automatically. A per-class circuit breaker stops autonomous runs after N
   consecutive failures.
7. Every proposal, decision, approval, execution, rollback, kill-switch change and
   circuit-breaker change appends to a hash-chained audit log that names the acting
   subject (a human `sub`, or the fixed service actor id for autonomy) and the policy
   version in force. `verifyChain` detects an edit, a reorder and a deletion.
8. The same proposal id never executes twice. A replay returns the first result, a
   concurrent duplicate shares the in-flight run, and the same id with a different
   payload is refused.
9. Time is injected (`now`), the executor is injected, and there is no randomness and no
   network. Money is BigInt minor units, never summed across currencies, and never rounded.

## Public API (`index.ts`)

Policy and registry: `ACTION_REGISTRY`, `buildRegistry`, `parseTenantPolicy`, `createEmptyPolicy`, `parseProposal`,
`validateParams`. Engine: `decide(proposal, policy, state, now)`. Autonomous path: `submitSystemProposal` (trusted
server code only), `runProposal`, `rollbackProposal`. Human path (each calls `authorize()`): `requestChange`,
`approveChange`, `applyChange`, `rollbackChange`, `setKillSwitch`, `resetCircuitBreaker`. Audit: `createAuditLog`,
`verifyChain`. Executor: the `Executor` interface and `InMemoryExecutor` (test double with failure injection).

## Autonomy-eligible classes (owner must confirm)

Only two seed actions are marked eligible, both low risk and reversible: `stop_idle_dev_instance` (class
`idle_stop`) and `schedule_on_off` (class `schedule`). Not eligible, by structure: `resize_down` (medium risk),
`delete_unattached_volume` (irreversible), `buy_commitment` (high risk, commitment impact; always human-approved).
A policy that names an ineligible class is refused at parse time, and `decide` re-checks on every call.

## Caps

16 parameter keys; 20 to 25 resources per action (registry hard max per action); 100 resources absolute; 10,000
proposals, window entries and 50,000 tracked resources per tenant; 32 freeze windows; 16 policy classes; 100,000 audit
records of at most 1,024 bytes with at most 12 detail keys of 120 characters. At a cap the operation is refused.

## Safety rails on the human path

A human-approved apply is refused with `HALTED` (409, fixed text) when the kill switch or platform halt is on, the
class circuit breaker is open, or a change-freeze window is active. There is no override in this build. The refusal is
written to the audit chain, and the approval stays valid, so the apply can be retried after the switch is released
(`setKillSwitch`) or the breaker is reset (`resetCircuitBreaker`), both authorized and audited. The check runs before
the dry run and again just before locks are taken.

## Known gaps

- No real executor. Real adapters must enforce their own timeouts (the orchestrator has no timers).
- State and the audit log are in memory and per process. Persistence, cross-process locking and external anchoring
  of the audit head (needed to detect a truncated tail) are not built.
- Dry-run evidence is keyed by proposal id and is produced by the orchestrator; there is no separate scheduler.
- The permission matrix has no kill-switch action. `setKillSwitch` and `resetCircuitBreaker` use a view.read check
  plus role lists (engage: cto, finops_lead, eng_lead; release and breaker reset: cto, finops_lead). The owner must
  confirm these roles or add a matrix action in a separate change.
- Denied human attempts are returned to the caller, not written to the audit chain (to keep a caller from filling it).
- Wiring to a route (for example next to `pages/api/v1/cm/change.ts`) is not done.
- Savings are checked only against cost at stake; they are not independently verified.
