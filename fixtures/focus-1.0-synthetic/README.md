# Synthetic FOCUS 1.0 export fixture — SYNTHETIC, NOT REAL PROVIDER DATA

This directory holds a **synthetic** FOCUS 1.0 cost export laid out like an AWS
Data Exports "FOCUS 1.0" CSV+gzip export. Every value is invented: the provider
is `SyntheticCloud`, account and resource ids are `syn-…` placeholders, and
amounts come from a fixed pseudo-random sequence. It exists only to exercise the
ingestion worker deterministically. **Never present results from this fixture
as a real-source result.** A real provider export must still be run through the
manual acceptance procedure (`.obvious/skills/ingestion-ops/SKILL.md`).

## How it was generated

```
npx tsx scripts/generate-focus-fixture.ts
```

The generator is `src/ingest/fixtures/syntheticFocus.ts` (committed). Money is
generated and summed as BigInt in units of 1e-10 and printed with exactly 10
decimal places — no floating point. `src/ingest/fixtures/syntheticFocus.test.ts`
fails if these files, `control-totals.json` or this README drift from the
generator.

## Layout (bucket-relative keys; seed each variant tree into a bucket root)

```
ratio-synthetic/focus-export/data/BILLING_PERIOD=YYYY-MM/<executionId>/focus-export-0000N.csv.gz
ratio-synthetic/focus-export/metadata/BILLING_PERIOD=YYYY-MM/focus-export-Manifest.json
```

- `base/` — 2026-07 (two data files) and 2026-08 (one data file).
- `restatement/` — the same export after the provider restated 2026-07 under a
  new execution id (five lines re-rated by +1.2345, one -12.5 credit added);
  2026-08 is byte-identical to `base/`. Upload it over `base/` to exercise
  period supersession.

Manifests list `dataFiles` (bucket-relative keys) and carry the Ratio extension
`x-ratio-control: { rowCount, billedTotal }` so reconciliation can be
demonstrated; real AWS manifests are not known to carry control totals.

## Deliberate duplicate legitimate rows

In 2026-07, data line 4 of file 00001 appears three times in that file, and data
line 8 of file 00001 appears again, byte-identical, in file 00002. All copies are
legitimate line items and must all be stored (row identity is artifact sha256 +
row ordinal, never a content hash). Lines 1 and 2 of file 00001 bill exactly
0.1000000000 and 0.2000000000.

## Control totals (exact decimal strings)

| variant | billing period | rows | billed total (BilledCost sum) |
|---|---|---|---|
| base | 2026-07 | 55 | 30.8272954899 |
| base | 2026-08 | 40 | 21.0978157665 |
| restatement | 2026-07 | 56 | 24.4997954899 |
| restatement | 2026-08 | 40 | 21.0978157665 |

Machine-readable copy: `control-totals.json`.
