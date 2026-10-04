// Issue #62: FOCUS ProviderName must match the source type. Pure.
// DESIGN: docs/evidence/issue-62/DESIGN.md §2–§3, §8 (decided by orchestrator, 2026-10-04).
//
// The source TYPE comes from the (RLS-visible) source row, never from the
// data. Matching is exact: case-sensitive, no trimming, no normalisation.
// Error messages name the column, the source type and the allowed set, and
// NEVER include the cell value.
import type { FieldError, HeaderIndex } from './validate';

/** Row-level reason: a present ProviderName outside the source type's allowlist (the row is excluded). */
export const PROVIDER_MISMATCH = 'PROVIDER_MISMATCH';

/**
 * Real provider values per source type.
 * - aws-data-exports: AWS Data Exports FOCUS 1.0 writes "AWS" (FOCUS 1.0 sample;
 *   DESIGN §2.1). "Amazon Web Services" is NOT allowed until a real export proves it (D5).
 * - fake: the test-only synthetic source has no real provider.
 */
export const SOURCE_TYPE_PROVIDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'aws-data-exports': Object.freeze(['AWS']),
  fake: Object.freeze([]),
});

/**
 * Provider names of the project's SYNTHETIC fixtures (syntheticFocus.ts,
 * testing/focusCsv.ts). Accepted, by any checked source type, ONLY with the
 * explicit opt-in RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 (default off; refused in
 * production; config.ts). Otherwise a tampered "AWS" export carrying them would
 * be published as AWS spend (DESIGN §8 D1). The synthetic provider names planned
 * for Slice 3 (brief D-04) are added here.
 */
export const SYNTHETIC_PROVIDER_NAMES: readonly string[] = Object.freeze(['SyntheticCloud']);

export interface ProviderPolicy {
  readonly sourceType: string;
  readonly allowed: readonly string[];
}

function policy(sourceType: 'aws-data-exports' | 'fake', allowSynthetic: boolean): ProviderPolicy {
  const base = SOURCE_TYPE_PROVIDERS[sourceType];
  return Object.freeze({ sourceType, allowed: allowSynthetic ? Object.freeze([...base, ...SYNTHETIC_PROVIDER_NAMES]) : base });
}

/**
 * The provider policy of a source row, or null when the row has no
 * recognised type. `allowSyntheticProviders` must be literally `true` to add
 * the synthetic provider names.
 */
export function providerPolicyFor(
  source: { kind: string; config: Record<string, unknown> | null | undefined },
  opts: { allowSyntheticProviders: boolean },
): ProviderPolicy | null {
  const allowSynthetic = opts.allowSyntheticProviders === true;
  if (source.kind === 'fake') return policy('fake', allowSynthetic);
  const config = source.config;
  if (source.kind === 'focus_file' && config !== null && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, 'layout') && config.layout === 'aws-data-exports') {
    return policy('aws-data-exports', allowSynthetic);
  }
  // Unrecognised type ⇒ not checked (DESIGN §8 D4). Unreachable from the CLI:
  // the source factory refuses every such row before any data is read, pinned
  // by src/ingest/worker/sourceFactory.test.ts ("D4 guard").
  return null;
}

/** Header check for a checked source type: ProviderName is a FOCUS 1.0 mandatory column. */
export function checkProviderHeader(index: HeaderIndex, p: ProviderPolicy): FieldError | null {
  if (index.pos.has('ProviderName')) return null;
  return { column: 'ProviderName', code: 'MISSING_REQUIRED_COLUMN', message: `ProviderName is required for source type ${p.sourceType} (FOCUS 1.0 mandatory column)` };
}

export type ProviderCheck = { ok: true } | { ok: false; exclude: boolean; error: FieldError };

/**
 * Row check. `value` is the validated row's ProviderName (null when empty).
 * - allowed (exact match) ⇒ ok;
 * - null ⇒ a hard MISSING_VALUE error (the batch is quarantined: fail closed);
 * - anything else ⇒ PROVIDER_MISMATCH, and the row is excluded.
 */
export function checkProviderName(value: string | null, p: ProviderPolicy): ProviderCheck {
  if (value === null) {
    return { ok: false, exclude: false, error: { column: 'ProviderName', code: 'MISSING_VALUE', message: 'required value is empty (FOCUS 1.0: ProviderName must not be null)' } };
  }
  if (p.allowed.some((a) => a === value)) return { ok: true };
  return {
    ok: false,
    exclude: true,
    error: {
      column: 'ProviderName',
      code: PROVIDER_MISMATCH,
      message: `ProviderName is not allowed for source type ${p.sourceType} (allowed: ${p.allowed.length ? p.allowed.join(', ') : 'none'}); row excluded`,
    },
  };
}
