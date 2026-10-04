// Issue #62: FOCUS ProviderName must match the source type. Pure.
// DESIGN: docs/evidence/issue-62/DESIGN.md §2–§3.
//
// The source TYPE comes from the (RLS-visible) source row, never from the
// data. Matching is exact: case-sensitive, no trimming, no normalisation.
// Error messages name the column, the source type and the allowed set, and
// NEVER include the cell value.
import type { FieldError, HeaderIndex } from './validate';

/** Row-level reason: a present ProviderName outside the source type's allowlist (the row is excluded). */
export const PROVIDER_MISMATCH = 'PROVIDER_MISMATCH';

/** The provider the project's synthetic fixtures write (syntheticFocus.ts, testing/focusCsv.ts). No real provider uses it. */
export const SYNTHETIC_PROVIDER_NAME = 'SyntheticCloud';

/**
 * Allowed ProviderName values per source type.
 * - aws-data-exports: AWS Data Exports FOCUS 1.0 writes "AWS" (FOCUS 1.0 sample;
 *   DESIGN §2.1). The synthetic fixture is staged in this layout by Slice 1
 *   tests, replay-fixtures and local:test, so its provider is allowed too
 *   (DESIGN §8 D1).
 * - fake: the test-only synthetic source.
 */
export const SOURCE_TYPE_PROVIDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'aws-data-exports': Object.freeze(['AWS', SYNTHETIC_PROVIDER_NAME]),
  fake: Object.freeze([SYNTHETIC_PROVIDER_NAME]),
});

export interface ProviderPolicy {
  readonly sourceType: string;
  readonly allowed: readonly string[];
}

function policy(sourceType: 'aws-data-exports' | 'fake'): ProviderPolicy {
  return Object.freeze({ sourceType, allowed: SOURCE_TYPE_PROVIDERS[sourceType] });
}

/**
 * The provider policy of a source row, or null when the row has no
 * recognised type. A null type is not checked; the CLI cannot run such a
 * source, because the source factory refuses it before reading any data
 * (DESIGN §8 D4).
 */
export function providerPolicyFor(source: { kind: string; config: Record<string, unknown> | null | undefined }): ProviderPolicy | null {
  if (source.kind === 'fake') return policy('fake');
  const config = source.config;
  if (source.kind === 'focus_file' && config !== null && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, 'layout') && config.layout === 'aws-data-exports') {
    return policy('aws-data-exports');
  }
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
    error: { column: 'ProviderName', code: PROVIDER_MISMATCH, message: `ProviderName is not allowed for source type ${p.sourceType} (allowed: ${p.allowed.join(', ')}); row excluded` },
  };
}
