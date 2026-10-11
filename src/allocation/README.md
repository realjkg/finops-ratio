# Allocation, showback, chargeback, tag governance, Kubernetes (`src/allocation/`)

RFQ readiness checklist Step 3 (items 3.1 to 3.6). Pure, deterministic
TypeScript: no I/O, no clock, no randomness, no new dependencies. Nothing in the
app imports this module yet; it is a library with tests.

## Purpose and trust boundary

Every input (rows, rules, pools, tag policies, Kubernetes metrics, clock values)
is untrusted. Bad, oversized or cross-tenant input throws `AllocationError`
with a fixed message chosen by `code`; the message never contains the input.
Calls are tenant scoped (a row from another tenant refuses the whole batch).
Deny by default: an unmatched row is `UNALLOCATED`, an unknown field is refused.

## Money

Integer minor units in `BigInt`, per ISO 4217 exponent (JPY 0, USD 2, KWD 3,
CLF 4). An unknown currency is refused. Amounts are strict decimals
(`-?digits(.digits)?`; no exponent, separators or locale). Money is never summed
across currencies. Splits use largest remainder with ties broken by ascending key.

Sub-minor-unit amounts: `allocateCosts` carries every amount at the exact scale
(minor unit plus 12 fractional digits) and rounds ONCE per currency and month,
by largest remainder (ties by line key), so output lines sum to the half-even
rounding of the exact total (1000 rows of 0.004 USD give 4.00, not 0.00). Totals
report `ledgerExact`, `ledger`, `roundingDifference`, `roundingResidualMinor` and
`roundedRows`; lines carry `exactAmount`. Digits beyond the exact scale are
rounded half-even and counted in `beyondExactScaleRows`. `rounding: 'refuse'`
restores strict mode (a sub-minor row aborts the batch); `'half-even'` is an alias
of the default. Tag-policy and Kubernetes inputs still refuse sub-minor amounts
by default (gap).

Target names containing Unicode format characters (zero-width, soft hyphen, BOM,
bidi controls) are refused, and the UNALLOCATED reserved-name check ignores them.
Look-alike letters from other scripts are not detected (gap).

## Public API (`index.ts`)

- `allocateCosts(tenant, rows, { rules, pools?, rounding? })` returns lines (each with `ruleId`) and per-currency totals; `allocated + unallocated == ledger` is checked on every call.
- Rules: ordered by unique integer `precedence`, first match wins. Conditions on tag (equals, prefix, oneOf, exists), account, service, region, resourceId. No regex: such input is refused.
- Pools: `proportional` (to direct spend by team, cost center or application), `even`, `fixedPercent` (must sum to exactly 100), `usageWeight`.
- `buildShowback`, `drillDown`: by cost center, team or application and month.
- `createChargebackBook`, `recordAllocation`, `closePeriod`, `buildChargeback`, `drillDownChargeback`: closed periods never change; restatements become adjustment lines in the next open period. Actor and time are injected; every change appends an audit record.
- `evaluateTagPolicy`: required keys, allowed values, alias, case, format, abbreviation and typo suggestions (bounded edit distance, work budget), compliance by gross spend and by resource count, violations with spend at risk.
- `apportionKubernetesCost`: node cost split by request, usage or max, explicit CPU/memory weights, idle and system overhead as lines, shared costs by policy.
- `fromCanonicalRow`, `tryFromCanonicalRow`: adapter from the canonical FOCUS row (strict `Tags` parsing).

## Caps (see `limits.ts`)

100,000 rows; 200 rules; 8 conditions per rule; 100 values per list; 100 pools;
500 pool targets; 64 tags per row; 16,384 characters of Tags JSON; 240 periods;
10,000 audit records; 5,000 nodes; 100,000 workloads; 100 shared costs. Each has
a test at the cap and one past it.

## Kubernetes units

CPU in millicores, memory in MiB, as bare integers. Suffixed values ("500m",
"2Gi") and any other declared unit are refused (`MIXED_UNITS`). Zero or negative
total node cost, zero capacity and mixed currencies are refused.

## Known gaps

- Not wired to the ingest path, the API or the UI. `fromCanonicalRow` takes `BilledCost` as a JS number, so float noise needs `rounding: 'half-even'`.
- The chargeback book is in-memory state the caller persists; there is no storage, no concurrency control and no approval workflow for closing a period.
- Proportional pools weigh direct spend within the same currency and month only. Usage weights are static per policy.
- Kubernetes: no pod-level time slicing, no GPU or storage resources, no network cost, no per-node-pool pricing. Inputs are assumed to come from one period.
- Currency table is a snapshot of ISO 4217 minor-unit exponents; funds and some codes are omitted. No FX conversion.
- Tag-policy suggestions are heuristics; no semantic matching.
- No claim of certification or audit coverage is made.
