// Allocation targets: the cost center, team and application a cost lands on.
//
// Trust boundary: target ids come from rule and pool configuration, which is
// untrusted input. Each id is length-capped, free of control characters, and
// may not impersonate the explicit `UNALLOCATED` bucket (compared after
// Unicode compatibility normalization, so a fullwidth lookalike is refused too).
// A target may set one, two or all three dimensions; a report by dimension D
// groups a line by its D value, or by UNALLOCATED when the line has none.

import { AllocationError } from './errors';
import { LIMITS, checkText, compareKeys, isPlainObject, own } from './limits';

export type Dimension = 'costCenter' | 'team' | 'application';
export const DIMENSIONS: readonly Dimension[] = ['costCenter', 'team', 'application'];

export interface Target {
  costCenter?: string;
  team?: string;
  application?: string;
}

/** The explicit bucket for spend no rule claimed (and for pool cost that cannot be split). Never dropped. */
export const UNALLOCATED = 'UNALLOCATED';

/** The `ruleId` recorded on a line that no rule matched. The `$` keeps it outside the user id alphabet. */
export const UNMATCHED_RULE_ID = '$unmatched';

export function isDimension(v: unknown): v is Dimension {
  return v === 'costCenter' || v === 'team' || v === 'application';
}

// Unicode format characters (category Cf), written as ranges because the build target predates \p{Cf}.
const FORMAT_CHARS = /[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/** True when the text contains an invisible Unicode format character (zero-width space, joiner, BOM, bidi controls). */
export function hasFormatChars(s: string): boolean {
  FORMAT_CHARS.lastIndex = 0;
  return FORMAT_CHARS.test(s);
}

/** True when `id` would collide with the UNALLOCATED bucket name, even with invisible characters mixed in. */
export function isReservedBucketName(id: string): boolean {
  return id.normalize('NFKC').replace(FORMAT_CHARS, '').trim().toUpperCase() === UNALLOCATED;
}

/** Validates an untrusted target and returns a frozen copy with only the dimensions that were set. */
export function validateTarget(raw: unknown, index?: number): Target {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_TARGET', index);
  for (const key of Object.keys(raw)) {
    if (!isDimension(key)) throw new AllocationError('INVALID_TARGET', index);
  }
  const out: Target = {};
  let count = 0;
  for (const dim of DIMENSIONS) {
    const v = own(raw, dim);
    if (v === undefined) continue;
    const id = checkText(v, LIMITS.maxTargetIdLength, 'INVALID_TARGET', {}, index);
    if (hasFormatChars(id)) throw new AllocationError('INVALID_TARGET', index);
    if (isReservedBucketName(id)) throw new AllocationError('RESERVED_ID', index);
    out[dim] = id;
    count++;
  }
  if (count === 0) throw new AllocationError('INVALID_TARGET', index);
  return Object.freeze(out);
}

/** Canonical, unambiguous key for a target: a JSON array of the three dimension values. */
export function targetKey(t: Target): string {
  return JSON.stringify([t.costCenter ?? null, t.team ?? null, t.application ?? null]);
}

/** The group a target (or an unallocated line, `null`) falls into for a report by `dimension`. */
export function groupOf(target: Target | null, dimension: Dimension): string {
  return target?.[dimension] ?? UNALLOCATED;
}

/** Orders groups for display: named groups by code-unit order, then UNALLOCATED last. */
export function compareGroups(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNALLOCATED) return 1;
  if (b === UNALLOCATED) return -1;
  return compareKeys(a, b);
}
