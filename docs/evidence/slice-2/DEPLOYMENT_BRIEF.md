# Ratio — deployment decision brief (Slice 2)

> **Governance state, in three lines:**
> 1. **D-01..D-10 are DECIDED** by the orchestrator under the owner's
>    delegation (2026-10-04; Decision log below).
> 2. **Production go-live remains a NON-DELEGABLE owner gate:** only the owner
>    signs it off (§7, owner action 1). That decision is **not** delegated.
> 3. **The acceptance run on public sample data is PERFORMED** (FOCUS 1.0
>    Sample Data, D-02). It is in the follow-up PR to #59, Slice 2b:
>    `docs/evidence/slice-2b/EVIDENCE.md`. It does not cover real billing
>    data (D-02 limits).
>
> What stays with the owner (§7):
> 1. the production go-live sign-off;
> 2. approving hosting spend;
> 3. installing the GitHub App;
> 4. optionally, connecting real billing data later.
>
> Nothing has been provisioned or spent. Everything built so far is local and
> ephemeral (BOUNDARY v2).

Status at the time of writing (branch `slice/02-local-env-brief`):

| Piece | Where it stands |
|---|---|
| Slice 0: Postgres foundation (schema `ratio`, RLS, roles, migration runner, catalog privilege model) | merged |
| Slice 1: FOCUS ingestion worker CLI (`ratio-ingest`: sync / backfill / replay / quarantine / doctor / replay-fixtures) | merged. Ingested so far, **all locally and ephemerally**: the SYNTHETIC fixture, and the public FOCUS 1.0 Sample Data (FinOps Foundation, CC BY 4.0; Slice 2b acceptance run). **No real billing data has ever been ingested.** |
| Slice 2: local stack + `GET /api/v1/costs/published` + this brief | PR #59 |
| Acceptance run (ingestion-ops SKILL §9) | **PERFORMED on public sample data** (updated by Slice 2b, branch `slice/02b-sample-acceptance`; evidence: `docs/evidence/slice-2b/EVIDENCE.md`). Dataset: FinOps Foundation FOCUS 1.0 Sample Data at commit `adbdd17a132984d6e8583c149c236d2199c3f5bc` (CC BY 4.0). Both files went through the real worker and the real API. **Current results (after #62, `fix/62-provider-source-check`)**: the source is an AWS Data Exports source, so the worker publishes the `ProviderName = AWS` rows only and excludes every other provider's rows (recorded as `PROVIDER_MISMATCH`, never published; a period whose rows are all foreign is quarantined). The reader totals equal control totals computed independently from the CSVs **for the AWS rows**, exactly: **1k file**: 2024-09 942 rows / BilledCost `18.00663861840`, 57 rows excluded (Microsoft 51, Oracle 6); 2024-10 (Oracle only, 1 row) quarantined `PROVIDER_MISMATCH`; **10k file**: 2024-09 9441 rows / `112.16617543240`, 557 excluded (Microsoft 491, Oracle 66); 2024-10 (Oracle only, 2 rows) quarantined (all USD; evidence: `docs/evidence/issue-62/EVIDENCE.md`). *Slice 2b history (before #62, all providers published under the AWS source):* 1k 999 / `20.28022672899` and 1 / `0.24000000000`; 10k 9998 / `151.41648035487` and 2 / `0.01361088710`. It does **not** cover real billing data (D-02 limits). |

## Decision log

Each decision below was **decided by the orchestrator under delegation,
2026-10-04**. The option analysis in §1 is kept as the rationale.

| ID | Decision | Rationale (one line) | Revisit when |
|---|---|---|---|
| D-01 | Source snapshot / evidence artifacts are **unrestricted ONLY** when the source encrypts them so that holding read access to the object is **not** enough to read the plaintext, AND that boundary has been **reviewed**. Exactly two cases qualify. **(1) SSE-KMS whose `SSEKMSKeyId` is on an explicit, audited ALLOWLIST of customer-managed key (CMK) ARNs.** Each allowlist entry records: the key ARN; who reviewed the key policy; when; and a SHA-256 hash of the reviewed policy document. The allowlist is a reviewed, versioned file, and adding an entry is a restricted change. The match is on the full key ARN as reported in the object metadata. Optionally, the worker re-reads the key policy at ingest (`kms:GetKeyPolicy`) and compares its hash with the recorded one, **failing closed** (restricted) on any difference or error. **(2) Client-side encryption by the source** (the stored object is ciphertext and the worker is not given the key). **Everything else stays restricted**, explicitly including: **`ServerSideEncryption: AES256` (SSE-S3)**, which S3 applies to every object by default since January 2023; **SSE-KMS with the AWS-managed `aws/s3` key**, which, like SSE-S3, is transparent to anyone holding `s3:GetObject`; and **any customer-managed key NOT on the allowlist**. Object metadata can show which key was used, not that its policy is a real access boundary: a CMK with a broad `kms:Decrypt` grant would otherwise pass. Foundation manifests (`src/ingest/db/migrations/*.manifest.json`) stay restricted review artefacts regardless. Enforcement is follow-up work, tracked in **realjkg/finops-ratio#60** (Appendix A). Until it lands, everything is treated as restricted, the safe subset. | "Encrypted by the source with strong encryption" means something only if the encryption is an access-control boundary independent of the bucket **and someone has verified that boundary**. Default, AWS-managed and unreviewed customer keys give no such assurance. Restricted-by-default never under-protects. | A source can only offer SSE-S3 or `aws/s3`; a reviewed key's policy changes (its hash no longer matches); or #60 lands. |
| D-02 | **The acceptance run uses the FinOps Foundation's public "FOCUS 1.0 Sample Data"**: https://github.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data at commit `adbdd17a132984d6e8583c149c236d2199c3f5bc`, files `FOCUS-1.0/focus_sample.csv` (1k rows) and `FOCUS-1.0/focus_sample_10000.csv` (10k rows). `FOCUS-1.0/README.md` at that commit states that it is anonymized real-world FOCUS data. **The two files contain AWS, Microsoft and Oracle data only.** The upstream README also lists Google, but there is no Google data in these files, so Google coverage is NOT tested by this run. **Licence: CC BY 4.0 — attribution is required** wherever the data, or results derived from it, are committed or published (credit the FinOps Foundation / FOCUS project, link the repository and the licence, and state any changes made). The data is loaded into the local SeaweedFS bucket, ingested by the worker, and read back through `GET /api/v1/costs/published`. The run is **not blocked on the owner**. It is a separate follow-up PR after #59 merges; nothing of it is in #59. **Status: PERFORMED on public sample data** (Slice 2b, `docs/evidence/slice-2b/EVIDENCE.md`; re-run after #62, `docs/evidence/issue-62/EVIDENCE.md`). Current, AWS rows only (#62 excludes other providers' rows from an AWS source): 1k: 942 / `18.00663861840`, 57 excluded, 2024-10 quarantined `PROVIDER_MISMATCH`; 10k: 9441 / `112.16617543240`, 557 excluded, 2024-10 quarantined; USD, exact. Slice 2b history (all providers, before #62): 1k: 999 / `20.28022672899` and 1 / `0.24000000000`; 10k: 9998 / `151.41648035487` and 2 / `0.01361088710`. **Still not covered**: a real AWS Data Exports manifest; how a real export writes nulls; Google data; real billing data. A real AWS (or Azure/GCP) billing connection becomes a later, **optional** owner action. When one is added, option (a) still applies: a read-only IAM role assumed via the SDK chain, with no static keys. | Real-world shape and three-provider coverage (AWS, Microsoft, Oracle) with no account access, so ingestion is validated now. The licence permits reuse with attribution. | The owner connects real billing data, or the sample's layout differs from what the worker expects (the sample is a set of CSV files, not an AWS Data Exports bucket layout; staging them in the expected layout is part of the follow-up PR). |
| D-03 | **Keep everything until a dedicated retention slice** (option a); a staging-only cleanup of `fixture-*` tenants comes first, as its own slice. | No purge path exists that respects the immutability triggers; keeping data is reversible, deleting is not. | Before the first non-pilot tenant, or storage cost becomes material. |
| D-04 | **An admin pre-creates the three NOLOGIN ratio roles; the migrator is NOCREATEROLE from day one** (option a, the local model). | Role creation never sits on an app credential; proven locally by `migrate --status` with `privilegeProblems: []`. | The managed Postgres offering cannot pre-create roles. |
| D-05 | **A separate monitoring login, a member of no ratio role, with SELECT on the ledger only** (option c). | Keeps the owner credential off worker hosts without changing the reviewed ratio privileges. | One more credential is judged too costly (fallback: option a). |
| D-06 | **Session tenant** (option a): one reader and one worker login per deployment; the app binds the tenant. | Simple and pooled; right for a single-tenant pilot. | Before a second external tenant shares a cluster. |
| D-07 | Items **1–3 now** (protect `main`, auto-merge for `low` only, Copilot `review_on_push`). For item 4, **option (b), a dedicated GitHub App** posting the gate's verdict as a check run. Installing it needs the owner's GitHub account (owner action 3). | Merge gating a workflow change cannot forge. | The plan gains required-workflow rulesets (option a), or the App is retired. |
| D-08 | **Stay on PostgreSQL 16** for the pilot; managed minor upgrades allowed; a major upgrade is a reviewed change. | Every test, baseline and pin is PG16; PG16 is supported to Nov 2028. | PG16 end of life approaches, or a needed feature is 17+. |
| D-09 | **Keep the per-row staged-only trigger** (option a). | Proven and mutation-tested; cost is about 10–18 µs per row. | The acceptance run shows a real month above a few million rows. |
| D-10 | **One API key per deployment** (option a), bound to its tenant by `RATIO_API_TENANT_ID`. | No new auth surface for the pilot. | Together with D-06, before multi-tenant production. |
| Hosting | **The plan is AWS** (§4 first row): RDS / Aurora PostgreSQL 16, S3 with versioning + object lock + SSE-KMS for evidence, ECS Fargate for the app, EventBridge Scheduler → ECS RunTask for the one-shot worker. Provisioning and spend stay owner actions (owner action 2, when Slice 3 provisions). | Native object lock and KMS (D-01, D-03); the worker's only real source type is AWS Data Exports, so a later AWS billing connection needs no cross-cloud credential. §4 listed options without naming one; this records AWS as the plan for those reasons. | Real billing data comes from another cloud, or the owner declines the spend. |

## 1. Option analysis considered before the decisions (historical rationale)

> **Historical.** This section was written BEFORE D-01..D-10 were decided
> (2026-10-04). It records the options that were considered and why; it does
> not describe open questions. The binding decisions are in the **Decision
> log** above. In each subsection, the option table is the analysis as it
> stood before the decision, "Recommended, then adopted" is what was decided,
> and "Depended on this decision" lists what the decision unblocked. Wording
> such as "before a second external tenant" names a revisit trigger (Decision
> log, "Revisit when"), not a pending decision.

### D-01: Scope of "snapshot files are unrestricted if encrypted by the source"

The owner's statement was: *"Snapshot files are unrestricted if they are
encrypted by the source with strong encryption."* Before the decision it was
**unresolved** which "snapshot files" it covered (resolved since: option (a),
below and in the Decision log). The two candidates considered were:
- **foundation manifests**: `src/ingest/db/migrations/*.manifest.json`, the
  generated catalog snapshot the migration runner and `migrate --status`
  compare against, and `systemPublicBaseline.ts`;
- **raw source-data snapshots / evidence**: the content-addressed FOCUS export
  bytes in the evidence bucket (`evidence/<tenant>/<source>/<sha256>`) and the
  provider's own export files.

| Option | Trade-offs |
|---|---|
| (a) It means raw source data / evidence only. Encrypted-at-source evidence may live in less restricted storage tiers; manifests stay restricted. | Matched the wording ("encrypted by the source"): manifests are generated by us, not the source. Kept the security baseline (manifests) under review. Needed a definition of "strong" (supplied by the decision: an audited CMK allowlist or client-side encryption). **Adopted.** |
| (b) It means manifests | Manifests are not secret, but they ARE the reviewed security baseline. Treating them as unrestricted would have let a baseline change through without restricted review. Not recommended; not adopted. |
| (c) Both | Both of the above risks. Not adopted. |

- **Decided (see the Decision log): option (a), with "strong encryption"
  defined as a REVIEWED access-control boundary.** That means either:
  - SSE-KMS with a customer-managed key on an **audited allowlist of CMK ARNs**
    (per entry: who reviewed the key policy, when, and the policy's SHA-256;
    optionally re-checked at ingest with `kms:GetKeyPolicy`, failing closed);
    or
  - client-side encryption by the source.

  What stays restricted:
  - **SSE-S3** (`AES256`, S3's default for every object since January 2023)
    and **SSE-KMS with `aws/s3`**: anyone with `s3:GetObject` reads them in
    plaintext, so "encrypted at rest" alone says nothing about who can read;
  - **a CMK that is not on the allowlist**: object metadata names the key but
    cannot show that its policy restricts `kms:Decrypt`. A CMK with a broad
    decrypt policy is no boundary.
  **Manifests stay restricted.** They live under `**/migrations/**`, which the
  governance gate already classifies as restricted, and a change to them is a
  reviewed security change. Enforcement: realjkg/finops-ratio#60.
- **Depended on this decision:** the evidence-bucket placement and storage
  class (with D-03), and any change to the governance classification of
  manifest files. Implementing the classification is engineering work tracked
  in #60 (Appendix A), not an open decision.

### D-02: The real FOCUS pilot source and its credentials

| Option | Trade-offs |
|---|---|
| (a) The owner's AWS account, Billing → Data Exports → FOCUS 1.0, CSV + gzip, read through an IAM **role** the worker assumes (SDK default chain, no static keys) | The worker's only real source today (D2). No long-lived secret. Needs a cross-account trust (ExternalId) if the worker runs in another account. |
| (b) Same export, read with an access key pair in the worker's secret store | Simpler to wire. A long-lived secret needs rotation. |
| (c) Another provider's FOCUS export | Not supported by the worker yet; a new source = a new slice. |

- **Decided (see the Decision log): the acceptance run uses the public
  FinOps Foundation FOCUS 1.0 Sample Data (CC BY 4.0, attribution
  required)**, a fourth option this analysis did not list. A real export is
  now a later, optional owner action. When it is connected, (a) applies: the
  role is read-only (`s3:GetObject`, `s3:ListBucket` on the export prefix),
  has no write or delete on the export bucket, and is restricted by bucket
  policy to that role.
- **What the sample run settles and what it does not:**
  - it validates parsing, validation, publication and the read path on real,
    multi-provider FOCUS 1.0 data (AWS, Microsoft and Oracle; no Google in these files), and gives D-09 a real row-size measurement;
  - it does **not** verify a real AWS Data Exports manifest's semantics
    (control totals expected absent ⇒ `unverified`; one or several manifests
    per period). That remains **unverified** (a known test gap, not an open
    decision) until real billing data is connected (optional owner action 4).
- **Status: PERFORMED on public sample data** (Slice 2b, evidence update
  under the orchestrator's delegation; `docs/evidence/slice-2b/EVIDENCE.md`).
  - **Dataset:** commit `adbdd17a132984d6e8583c149c236d2199c3f5bc`, both files,
    with SHA-256s pinned. The 1k file is committed verbatim with a CC BY 4.0
    `NOTICE.md`.
  - **What ran:** each file was staged as an AWS Data Exports layout. The
    staging changes only the format: it maps the unquoted `NULL` token to an
    empty field, splits the rows by period and gzips them, and it is proven
    lossless. The real worker CLI synced each file twice (`published`, then
    `skipped_unchanged`), and the data was read back through the real API.
  - **Exclusion policy (#62):** an AWS Data Exports source publishes only
    rows whose `ProviderName` is exactly `AWS`. Each other provider's row is
    excluded and recorded as `PROVIDER_MISMATCH` on the batch. The rest of
    the batch is published, and a batch whose rows are all foreign is
    quarantined and never published. A NULL `ProviderName` quarantines the
    batch (`docs/evidence/issue-62/DESIGN.md`).
  - **Control totals, current** (after #62; computed independently in
    Python from the CSVs, AWS rows only; all USD; equal to the API, exactly):

    | File | Period | Rows | BilledCost | Excluded | Worker outcome |
    |---|---|---|---|---|---|
    | 1k | 2024-09 | 942 | `18.00663861840` | 57 (Microsoft 51, Oracle 6) | published |
    | 1k | 2024-10 | — | — | 1 (Oracle) | quarantined `PROVIDER_MISMATCH` |
    | 10k | 2024-09 | 9441 | `112.16617543240` | 557 (Microsoft 491, Oracle 66) | published |
    | 10k | 2024-10 | — | — | 2 (Oracle) | quarantined `PROVIDER_MISMATCH` |

  - **Slice 2b history** (before #62, every provider's rows published under
    the AWS source; superseded by the table above):

    | File | Period | Rows | BilledCost |
    |---|---|---|---|
    | 1k | 2024-09 | 999 | `20.28022672899` |
    | 1k | 2024-10 | 1 | `0.24000000000` |
    | 10k | 2024-09 | 9998 | `151.41648035487` |
    | 10k | 2024-10 | 2 | `0.01361088710` |

  - **Also checked:**
    - **every API row against its upstream record, field by field**, keyed
      by `Id`. The expected row comes from the upstream CSV via the
      independent Python calculator, never from the staged copy. It covers
      all 21 upstream-derived fields of the API row:
      - billingPeriod (YYYY-MM-DD) and the two charge-period timestamps
        (UTC, microseconds, as the API formats them);
      - the four cost columns, usage and pricing quantities (decimal
        strings, exact, scale included);
      - currency, provider, service, service category, charge category,
        resource, sub-account and billing-account ids, units;
      - focusVersion;
      - `extraColumns`, with the same keys and values as the upstream file.

      An upstream `NULL` must be null or absent. The API row must have
      exactly the route's 26 fields. The upstream column classification is
      pinned: 19 mapped columns, 25 returned verbatim in `extraColumns`,
      none dropped;
    - per-group row digests, EffectiveCost sums and null counts;
    - the evidence re-hash;
    - the catalog (published, `unverified`, not provisional).
  - **Mutations:** ten data mutations each fail the run, including six text
    columns corrupted and ListCost + 1 in the last digit.
  - **CI:** the 1k run is in CI.
  - **Limits, unchanged:**
    - a real AWS Data Exports manifest is **not** verified (the staged
      manifest follows the worker's documented contract);
    - how a real export writes nulls is **not** confirmed (the `NULL` token
      is a property of this SQL-dump sample);
    - **no Google data** is in these files;
    - **real billing data** is not covered. That stays the optional owner
      action 4.

### D-03: Retention windows and the purge path

Today **nothing is ever deleted**. That covers:
- evidence objects;
- superseded batches and their facts;
- quarantined batches (their facts are deleted; the errors stay);
- `replay-fixtures` tenants in staging (one tenant per run, measured at about
  341 rows and about 75 KB of objects).

Slice 0's triggers forbid deleting facts of published or superseded batches.
So **any purge needs a reviewed mechanism**: a contract-phase migration or an
owner-run procedure. A `DELETE` from the app cannot do it.

| Option | Trade-offs |
|---|---|
| (a) Keep everything until a dedicated retention slice | Safe; storage grows without bound (evidence ≈ export size; facts ≈ rows × revisions). |
| (b) Windows per class, e.g. evidence ≥ 13 months (an audit year plus a close), superseded batches 90 days after supersession, quarantine errors 1 year, staging fixture tenants 14 days | Bounded cost; needs a purge path that respects the triggers and the publication pointer, plus an evidence lifecycle rule that never deletes an object a retained batch references. |
| (c) A legal-hold-aware policy (object lock in compliance mode, never shortened) | Strongest audit story; deletions become impossible inside the window, so the windows must be right. |

- **Recommended, then adopted (Decision log):** (a) for the pilot, with a
  staging-only cleanup of `fixture-*` tenants as its own owner-approved slice.
  Revisit trigger: (b) or (c) before the first non-pilot tenant.
- **Depended on this decision:** production storage sizing and cost, compliance sign-off, and
  growth of the staging database.

### D-04: The non-superuser production migrator

Slice 0: the migrating login must be a member of `ratio_owner`, with
CREATEROLE only if the three ratio roles do not exist yet.

The local stack (`scripts/local/bootstrap.mjs`) demonstrates a model where the
migrator **never** needs CREATEROLE:
- an administrator pre-creates `ratio_owner`, `ratio_worker` and `ratio_reader`
  exactly as 0001 would (NOLOGIN, no attributes, no memberships);
- `<migrator> LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE IN ROLE ratio_owner`
  owns the database.

This passes 0001's guard and the runner's catalog check (`migrate --status`
reports no privilege problem, verified by `local:test`).

| Option | Trade-offs |
|---|---|
| (a) An admin pre-creates the roles; the migrator is NOCREATEROLE from day one (local model) | No role-creation power ever on an app credential. Needs one admin step per cluster. |
| (b) The migrator gets CREATEROLE for the first deploy only, then `ALTER ROLE … NOCREATEROLE` (Slice 0 round-16 note) | No separate admin step. A window in which an owner login could create roles and grant them `ratio_worker`/`ratio_reader`. |
| (c) The platform's admin user migrates (e.g. RDS master) | **Not viable as is.** Managed "admin" users are members of roles such as `rds_superuser`, which can reach `pg_signal_backend` and others. The catalog check refuses owner-side members that can reach `REFUSED_PREDEFINED_ROLES`. |

- **Recommended, then adopted (Decision log):** (a). The admin credential is
  used once, by a human, and is never stored in app or worker configuration.
- **Depended on this decision:** the first production migration.

### D-05: Doctor's ledger read: a SELECT grant on `schema_migrations` or the owner credential

`doctor`'s `migration_version` check reads `public.schema_migrations`, which
`ratio_worker` cannot. Today it uses `RATIO_MIGRATE_DATABASE_URL` (the owner)
inside a READ ONLY transaction. If that variable is unset, the check fails; it
is never skipped.

| Option | Trade-offs |
|---|---|
| (a) `GRANT SELECT ON public.schema_migrations TO ratio_worker` | Least moving parts. It is a role-privilege change: `REVIEWED_PRIVILEGES`, the foundation manifest and several Slice 0 tests change (a reviewed migration). |
| (b) Keep the owner URL in a READ ONLY transaction (current) | No schema change. The **owner credential sits on the worker host**, so a compromise of the worker host gives an owner login (which can disable RLS). |
| (c) A separate monitoring login, a member of **no** ratio role, with SELECT on the ledger only | Owner credential stays off worker hosts; no change to the reviewed ratio privileges. One more credential to manage. Fits the Slice 0 monitoring note (§3). |

- **Recommended, then adopted (Decision log):** (c), with (a) as the recorded
  fallback if one more credential is judged too costly.
- **Depended on this decision:** running scheduled `doctor` in production without owner
  credentials on the worker host.

### D-06: Session tenant or per-tenant database roles

Today the tenant is a transaction-local setting (`ratio.tenant_id`). RLS
defends against **application bugs** (a missing or wrong tenant). It does not
defend against a **credential holder**: anyone holding the worker or reader
credential can set any tenant (Slice 0 threat model, round 2 M5).

| Option | Trade-offs |
|---|---|
| (a) Session tenant (current); one reader and one worker login per deployment; the app binds the tenant (Slice 2: `RATIO_API_TENANT_ID`) | Simple, pooled connections. Tenant safety rests on credential custody and on the app. |
| (b) Per-tenant LOGIN roles; policy on `current_user` → tenant | A stolen credential reaches one tenant. Needs role provisioning per tenant, more connections (no shared pool), and a policy and catalog-check redesign (Slice 0 change). |
| (c) A database (or cluster) per tenant | Strongest isolation; highest operating cost; the migration fan-out needs tooling. |

- **Recommended, then adopted (Decision log):** (a) for a single-tenant pilot.
  Revisit trigger: (b) or (c) before a second **external** tenant shares a
  cluster.
- **Depended on this decision:** multi-tenant production and D-10.

### D-07: GitHub admin actions (applied by a repository admin)

The items considered (applying them needs repository-admin rights that no
agent holds):
1. **Protect `main`** (`scripts/governance/protect-main.mjs` prepares it):
   required checks `CI` and the governance gate, required PR review, no force
   push, no deletion, linear history if desired.
2. **Auto-merge:** enable it only for PRs the governance gate classifies `low`.
   Restricted classes keep a human merge.
3. **Copilot `review_on_push`:** enable it so every push gets a review, not only
   the first.
4. **The governance gate's own protection:**
   - **(a)** an org/repo **ruleset that requires the governance workflow**
     (needs a plan that supports required workflows); or
   - **(b)** a **dedicated GitHub App** with `checks:write`, posting the
     gate's verdict as a check run a workflow change cannot forge.

- **Recommended, then adopted (Decision log):** items 1–3 now; for item 4,
  option (b), the GitHub App (option (a) was not available on the plan).
  Applying them is an admin action (§7 owner action 3, §8), not an open
  decision.
- **Depended on this decision:** trustworthy merge gating; any autonomous merge.

### D-08: The PostgreSQL 16 pin

Everything is pinned to PostgreSQL 16:
- CI (service `postgres:16`, PG16 client tools pinned by path);
- local (`postgres:16@sha256:…`);
- Slice 0's PUBLIC system baseline, which records the major version it was
  generated on.

| Option | Trade-offs |
|---|---|
| (a) Stay on 16 for the pilot; allow the managed provider's minor upgrades | Matches every test and baseline; PG16 community support runs to Nov 2028. |
| (b) Move to 17 now | Newer features. Requires regenerating the system baseline and manifests (`scripts/ingest/generate-foundation-manifest.mjs`), re-running the privilege and drift suites, and a reviewed change. |

- **Recommended, then adopted (Decision log):** (a). A major upgrade is a
  reviewed change (regenerate, review the diff, run the full DB suite on the
  new major).
- **Depended on this decision:** the choice of managed Postgres offering and version.

### D-09: Per-row staged-only trigger cost

Measured in Slice 1: about **10–18 µs per row** (+25–45 % of the whole load,
including parse, gzip and evidence I/O) at 200k rows. That is about +2–3.7 s per
200k rows.

| Option | Trade-offs |
|---|---|
| (a) Keep the per-row trigger | Simple, proven, mutation-tested. Cost grows linearly. |
| (b) A statement-level trigger (one check per chunk) | Removes most of the cost. A Slice 0 change (trigger, manifest, tests), so a reviewed migration. |

- **Recommended, then adopted (Decision log):** (a). Revisit trigger: the
  acceptance run (D-02) shows a real month above a few million rows.
- **Depended on this decision:** nothing for the pilot; capacity planning for large tenants.

### D-10: A store of several keys, each bound to a tenant

Slice 2 reuses the existing API auth unchanged:
- **One** Bearer key (`RATIO_API_TOKEN`, strong; deny by default; failed
  attempts throttled).
- That key is bound server-side to its Ratio tenant by `RATIO_API_TENANT_ID`,
  which is validated as a UUID at startup and per request; missing or invalid
  ⇒ 503.
- The tenant is never read from the request.
- So **one deployment serves one tenant**. A store of several keys, each bound
  to a tenant, does not exist.

| Option | Trade-offs |
|---|---|
| (a) Keep one key per deployment (current) | No new auth code. One deployment (or env set) per tenant. |
| (b) An owner-managed key table: high-entropy keys stored only as hashes, each bound to a tenant, with rotation and revocation, plus the existing throttling | Several tenants per deployment. New auth surface: needs its own design, threat model and review (key issuance, storage, audit log). |
| (c) An external IdP (OAuth2 client credentials); a tenant claim mapped to a Ratio tenant | Standard and auditable. Adds an IdP dependency and token-validation code. |

- **Recommended, then adopted (Decision log):** (a) for the pilot. Revisit
  trigger: (b) or (c), together with D-06, before multi-tenant production.
- **Depended on this decision:** serving more than one tenant from one deployment.

## 2. Slice 0 deployment notes (carried forward)

- **Migrator CREATEROLE only for the first deploy, then NOCREATEROLE.** That is
  the Slice 0 recommendation. D-04 (a) removes even that window. CREATEDB is
  never needed.
- **The owner's CREATE on schema `public`** (needed once, to create the ledger).
  Do one of the following:
  1. **Recommended:** after the first migration, drop it.
     - If the migrator does not own the database: `REVOKE CREATE ON SCHEMA
       public FROM <migrator>`.
     - If it does: revoke it from `pg_database_owner`, or move `public` to a
       NOLOGIN admin role.
  2. **Or pin `search_path`** on the worker and reader logins at connection
     time. The read API already does this itself (`search_path=pg_catalog,pg_temp`,
     read-only, timeouts). Never use `ALTER ROLE … SET search_path`: the
     catalog check refuses stored settings on ratio-role members.
- **Monitoring needs a separate login** (`pg_monitor`, `pg_read_all_stats`,
  …) that is **not a member of any ratio role**. A ratio-role member that can
  reach a monitoring role is refused by the catalog check, by the worker, and
  now by the read API.
- **Logins never get explicit grants.** Membership in exactly one ratio role
  is the whole privilege model. The catalog check refuses anything beyond the
  reviewed set.
- **Audit every member of each ratio role, not only the intended logins.** A
  stray `GRANT ratio_reader TO x` gives `x` the reader's access. The local
  bootstrap refuses any membership edge touching a ratio role or one of its
  logins beyond the expected three, and revokes nothing (DESIGN §3.1 item 6).
  An operator should check the same thing on a production cluster.
- **Down migrations are refused in production** by design. A production
  rollback of 0001 would drop all ingested data, which is a retention decision
  (D-03).

## 3. Slice 1 operating notes (carried forward)

| Setting / fact | Default | Production note |
|---|---|---|
| `RATIO_DOCTOR_FIRST_PUBLISH_GRACE_HOURS` (`NEVER_PUBLISHED` grace) | 48 h from the source's `created_at` | AWS Data Exports can take up to 24 h to deliver the first export. Inside the window the finding is silent (`data.firstPublicationGrace: true`); after it, a source with zero publications fails doctor. |
| `RATIO_MAX_RUN_SECONDS` | 21 600 (6 h) | Set **below** the scheduler's job timeout so a run aborts itself (`MAX_RUN_EXCEEDED`, checkpoint untouched) before the platform kills it. |
| `RATIO_LEASE_TTL_SECONDS` | 300 | A crashed run blocks its source until the lease expires; the next run then marks it `abandoned` and cleans its staged batch. A schedule interval far above the TTL keeps runs from overlapping; the lease makes overlap safe (exit 4) anyway. |
| `RATIO_STALL_TIMEOUT_SECONDS` | 120 | A stream idle this long fails `SOURCE_STALLED`/`EVIDENCE_STALLED` (retried within the budget); a run without progress stops renewing its lease. |
| DB session timeouts | lock 30 s, idle-in-tx 5 min, statement 30 min | Statement timeout must exceed the largest legitimate statement (deleting a 20M-row staged batch at acquisition). |
| **Evidence bucket write protection: an ASSUMPTION** | — | Tamper detection happens when evidence is captured (full re-hash; conditional `If-None-Match: *` PUT) and loaded (re-hash). Evidence of unchanged or superseded periods, republish and `replay --batch` is **not** re-read (HEAD-metadata fast path for artifacts). The design assumes **only the worker credential can write** the evidence bucket, and it has **no delete**. Recommended: bucket versioning + object lock (governance or compliance mode, D-03), a deny-delete bucket policy, access logging. |
| Optional evidence audit job (issue #58, item 2) | not built | A periodic job that re-hashes evidence objects and compares them with `ingest_artifacts.sha256`, restoring continuous assurance on the fast paths above. Recommended before production if object lock is not used. |
| `replay-fixtures` | refused outside `staging`/`test` | Leaves one fixture tenant per run (no purge, D-03). |

## 4. Hosting options (plan: AWS, see the Decision log; provisioning and spend are owner actions)

The shape that follows from the code:
- managed **Postgres 16**;
- **S3-compatible** object storage for evidence;
- the **Next.js app** as a long-running or serverless service;
- the worker as a **scheduled one-shot job**, never a daemon. Each run is
  `sync`, exits with the documented code and prints one evidence record.

| Option | Postgres 16 | Object storage | App | Worker (scheduled one-shot) | Notes |
|---|---|---|---|---|---|
| AWS | RDS / Aurora PostgreSQL 16 | S3 (versioning + object lock, SSE-KMS) | ECS Fargate service or App Runner | EventBridge Scheduler → ECS RunTask | Same account as the FOCUS export simplifies D-02 (role assumption). The RDS master user is not a usable migrator (D-04). |
| GCP | Cloud SQL for PostgreSQL 16 | GCS (S3 interoperability API, HMAC keys) or AWS S3 cross-cloud | Cloud Run service | Cloud Scheduler → Cloud Run Job | Interoperability mode needs HMAC keys (a static credential). |
| Azure | Flexible Server PG 16 | S3-compatible gateway or AWS S3 | App Service / Container Apps | Container Apps Jobs (cron) | No native S3 API; an extra moving part. |
| Kubernetes (any) | operator-managed or external managed PG | MinIO / external S3 | Deployment | CronJob (`concurrencyPolicy: Forbid`, `restartPolicy: Never`) | Most control, most to operate. |
| Serverless app (e.g. Vercel) + managed PG + S3 | any of the above | any | serverless functions | needs a separate scheduler/runtime for the worker | Per-instance pools (cap `max` with the DB's connection limit); failed-auth throttling is per instance (already documented). |

Cross-cutting for every option:
- TLS to Postgres and S3. The worker refuses `http://` S3 endpoints when
  `RATIO_ENV=production`.
- Secrets in the platform secret store, never in images.
- One reader login and one worker login per environment.
- The admin credential is never deployed.

## 5. Security posture summary

| Area | Control (where verified) |
|---|---|
| Tenant isolation | FORCE RLS on every table; tenant set transaction-locally with a bound parameter (`withTenantTransaction`); composite tenant FKs; the reader sees only the definer-rights published view (Slice 0 suites). The API binds the tenant server-side, never from the request (Slice 2 D1, mutations M2/M2b). |
| Published-only reads | Reader grant = view only; the view joins the pointer and `status = 'published'` (Slice 0). The API reads only the view; a base-table read is refused by grants (Slice 2 D2, mutation M4). |
| Privilege model | Reviewed privilege allow-list, catalog check after every migration and on status, refused predefined roles, member closure over every edge kind (Slice 0). The worker refuses unsafe logins (Slice 1). The read API refuses superuser, BYPASSRLS, owner, worker-reachable and refused-role logins on every request (Slice 2 D6 + serial suite, mutations M3/M3b/M3c). |
| API auth | Existing deny-by-default Bearer auth, strong-token rule, failed-attempt throttling, per-tenant rate limit, fixed error messages (Slice 2 R1, mutation M1). |
| Input handling | Strict validation; keyset pagination ≤ 500; bound parameters only; 10 s statement timeout. |
| Bundle hygiene | Import boundary + import-closure tests; `check:bundle` on every CI build (no driver/ingestion code client-side; reader code only in the costs route's own chunks). |
| Data integrity | Immutable published facts, fenced publication, exact numeric money end to end (decimal strings in the API), reconciliation vs control totals (Slices 0–1; `local:test` asserts the exact totals). |
| Evidence | Content-addressed, verified on capture and load. **Write protection of the bucket is an assumption** (§3). |
| Secrets | No secret columns (CHECKs refuse secret-like config); redaction before logs and persistence; `.env.example` names only; local secrets generated and gitignored. |
| Known residual risks | A credential holder can choose any tenant (D-06). The owner credential sits on the worker host for doctor (D-05). Evidence tamper detection is not continuous (§3, #58). Real export semantics are unverified (D-02). |

## 6. Rollback plan

- **App code:** redeploy the previous image or commit. Slice 2 adds **no
  migration**. Its only Slice 0 change is a behaviour-preserving lazy load of
  the manifest. So a code rollback needs no database action.
- **Read API kill switch.** What the code actually does:
  - **Configuration:** unset `RATIO_READER_DATABASE_URL` or
    `RATIO_API_TENANT_ID`, then restart the app ⇒ the route answers 503
    `not_configured` and opens no database connection. The environment is read
    per request, but most platforms change env only on a restart.
  - **Database, no restart:** `ALTER ROLE <reader login> NOLOGIN`.
    - NOLOGIN by itself stops only NEW connections; Postgres does **not** end
      existing (pooled) sessions.
    - The read API closes that gap: its per-request login check also refuses a
      login whose `rolcanlogin` is false. The **very next request** on a pooled
      connection gets 503 `unsafe_db_login` (reason `LOGIN_DISABLED`; tested
      live in `publishedCosts.db.test.ts` D6).
    - To also end the idle pooled sessions themselves:
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '<reader login>'`,
      or restart the app.
    - `ALTER ROLE … LOGIN` re-enables serving; no restart is needed.
  - Other tools holding a reader session (e.g. a psql shell) are not covered
    by the API check: terminate them with `pg_terminate_backend`.
- **Data:** `replay --batch <superseded batch>` re-points a period atomically
  and pins it; `replay --batch <newer>` rolls forward; `replay --period`
  re-ingests and unpins (Slice 1). Superseded batches and evidence are
  retained.
- **Schema:** down migrations are refused in production by design. A schema
  rollback is a forward fix (expand/contract) or, for 0001, a retention
  decision (D-03).
- **Credentials:** rotate by creating a new login in the same ratio role,
  switching the secret, then `DROP ROLE` the old login. No privilege change
  is involved.
- **Worker schedule:** disable the scheduler. A running job finishes or aborts
  at `RATIO_MAX_RUN_SECONDS`. The lease and fencing make a later restart safe.

## 7. Owner actions

The design decisions are made (Decision log). The owner keeps the production
go-live decision, which is non-delegable, and the actions only the owner can
take:

1. **Owner sign-off for production go-live.** This is a non-delegable human
   gate: nothing goes to production until the owner signs off. It comes after
   every release readiness check in §8 has passed.
2. **Approve the hosting spend** when Slice 3 provisions the AWS plan (Decision
   log, Hosting).
3. **Install the GitHub App** for the governance gate (D-07 item 4, option b).
   It needs the owner's GitHub account.
4. **Connect real billing data later (optional).** When the owner wants it:
   the S3 bucket and prefix of a real FOCUS export, and a read-only IAM role
   ARN the worker may assume (D-02, option a). This does **not** block the
   acceptance run, which uses the public FOCUS 1.0 Sample Data (D-02).

## 8. Release readiness checks (engineering; verified when Slice 3 provisions)

These are verification steps, not decisions. Each is checked before the first
production deploy:

- [x] **The acceptance run performed on public sample data and signed off
      by the orchestrator under the owner's delegation (Slice 2b PR)**: the
      FOCUS 1.0 Sample Data (D-02), in the follow-up PR to #59
      (`docs/evidence/slice-2b/EVIDENCE.md`). All of these were checked:
      - row counts vs the CSV files;
      - totals per period and currency vs totals computed independently from
        the CSV, equal exactly. Since #62 these are the **AWS rows only**: the
        worker excludes every other provider's rows (`PROVIDER_MISMATCH`) and
        quarantines a period whose rows are all foreign. The run checks the
        excluded counts (1k: 57, and 2024-10 quarantined; 10k: 557, and
        2024-10 quarantined) and the stored error codes. The Slice 2b
        all-provider totals are history (D-02);
      - every API row equal to its upstream record, field by field;
      - idempotent re-sync;
      - evidence re-hash;
      - read back through the API;
      - the CC BY 4.0 attribution recorded.

      This sign-off covers the acceptance run only. It is **not** the
      production go-live sign-off, which stays the owner's non-delegable
      gate (§7, owner action 1). A real billing comparison (vs the Billing
      console) follows only if the owner connects real data (optional owner
      action 4). It is **not** covered by this tick (D-02 limits).
- [ ] D-09 reviewed against the acceptance run's size.
- [ ] D-07 items 1–3 applied (protect-main, auto-merge for `low` only, Copilot
      review_on_push); the GitHub App installed (owner action 3).
- [ ] Postgres 16 provisioned on the hosting plan with TLS; backups and
      point-in-time recovery enabled and **a restore tested** (after owner action 2).
- [ ] Roles created per D-04. `migrate`, then `migrate --status --json` exits 0
      with `privilegeProblems: []`. Owner `CREATE` on `public` removed (§2).
- [ ] Worker and reader logins: one membership each. The API answers 200 (not
      503 `unsafe_db_login`), and the worker starts (no `UNSAFE_DB_ROLE`).
- [ ] Evidence bucket: worker-only write, no delete, versioning (+ object lock
      per D-03), encryption per D-01, access logs. Audit job decided (#58).
- [ ] Secrets only in the secret store; strong `RATIO_API_TOKEN` (≥ 32 chars,
      ≥ 10 distinct); `RATIO_API_TENANT_ID` set (startup log shows no
      `startup_config_invalid`).
- [ ] Worker scheduled as a one-shot job; `RATIO_MAX_RUN_SECONDS` < job timeout;
      doctor scheduled with alerting on a non-zero exit.
- [ ] Monitoring login separate from every ratio role (§2).
- [ ] CI green on the release commit, including `check:bundle` and `local:test`.
- [ ] Rollback plan (§6) rehearsed in staging, including the NOLOGIN kill switch.
- [ ] **Owner sign-off for production go-live recorded (owner action 1). Non-delegable.**

## Appendix A: D-01 enforcement, tracked in realjkg/finops-ratio#60

The D-01 decision needs enforcement code. It is tracked in **issue #60**,
which the orchestrator keeps in line with this appendix. This appendix is the
specification the issue implements.

**Context:** D-01 (decided 2026-10-04). Today every artifact is treated as
restricted, the safe subset. The worker records no encryption metadata.

**Scope:**
- At capture time, the worker reads the source object's encryption metadata
  from the S3 HEAD/GET response: `ServerSideEncryption`, `SSEKMSKeyId` and the
  bucket-key flag. If the source declares client-side encryption, it also reads
  the envelope's metadata.
- **The CMK allowlist:** a reviewed, versioned file. It is part of the
  restricted change class, so adding an entry needs restricted review. One
  entry per key: `{ keyArn, policySha256, reviewedBy, reviewedAt }`. The
  reviewer confirms that the key policy (and its grants) restricts
  `kms:Decrypt` to the intended principals. `policySha256` is the SHA-256 of
  the policy document as returned by `kms:GetKeyPolicy`, canonicalised
  (JSON with sorted keys, no whitespace).
- It records a classification per artifact. Exactly one of:
  - `sse-kms-allowlisted`: `aws:kms` / `aws:kms:dsse` whose `SSEKMSKeyId`
    (the full key ARN) is an allowlist entry. If the optional runtime check
    is enabled, `kms:GetKeyPolicy` must also return a policy whose hash equals
    the entry's `policySha256`; a different hash or any KMS error ⇒
    `restricted`;
  - `client-side`;
  - `restricted`: everything else, including `AES256` (SSE-S3), `aws/s3`
    SSE-KMS, **any CMK not on the allowlist**, no header, an unknown value, or
    a metadata read that fails.
- Only `sse-kms-allowlisted` and `client-side` may be classed
  "unrestricted".
- Foundation manifests stay restricted regardless.

**Acceptance criteria (tests first: a red commit before the implementation):**
1. **Unit, classification from header combinations:**
   - `aws:kms` with an allowlisted CMK ARN ⇒ `sse-kms-allowlisted`;
   - **`aws:kms` with a customer-managed key ARN NOT on the allowlist (e.g. a
     CMK whose policy grants broad `kms:Decrypt`) ⇒ `restricted`**;
   - an allowlisted ARN whose current key policy hash differs from the
     recorded `policySha256` (runtime check enabled) ⇒ `restricted`, and a
     `kms:GetKeyPolicy` error ⇒ `restricted`;
   - an alias, or a key id instead of the full ARN, does not match an ARN
     entry ⇒ `restricted`;
   - `ServerSideEncryption: AES256` (SSE-S3, S3's default since January 2023)
     ⇒ **`restricted`**;
   - `aws:kms` with `SSEKMSKeyId` = `alias/aws/s3`, or the AWS-managed `aws/s3`
     key ARN ⇒ **`restricted`** (it can never be on the allowlist: an
     allowlist entry whose key has `KeyManager = AWS` is rejected when the
     allowlist is loaded);
   - a missing, empty or unknown header ⇒ `restricted`;
   - a metadata or key-lookup error ⇒ `restricted`.
   - Nothing defaults to unrestricted.
2. **Allowlist file validation:** each entry needs a full ARN, a 64-hex
   `policySha256`, `reviewedBy` and an ISO `reviewedAt`. A malformed file
   makes **every** artifact `restricted` (fail closed), with an error logged.
3. **S3 integration** (SeaweedFS, or a fake client where SeaweedFS lacks KMS):
   objects with no header, `AES256`, `aws/s3`, a non-allowlisted CMK and an
   allowlisted CMK are classified as above at capture.
4. **Persistence:** the classification is stored with the artifact, together
   with the allowlist entry's `policySha256` it was judged against. If this
   needs a schema change, it is an expand migration with its own reviewed
   manifest update.
5. **Mutations, each of which must fail a test:**
   - classifying a missing header as encrypted;
   - classifying `AES256` as unrestricted;
   - accepting the `aws/s3` key;
   - accepting any CMK that is not on the allowlist;
   - ignoring a policy-hash mismatch (runtime check enabled).
6. **No behaviour change for consumers** until a reviewed consumer uses the
   classification (default restricted).
