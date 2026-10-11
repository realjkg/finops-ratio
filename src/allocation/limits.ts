// Caps and shared input checks for the allocation module.
//
// Trust boundary: nothing here trusts its input. Every collection and string
// that crosses into the module is bounded by a constant below, and each cap has
// a test at the cap and one past it. Control characters and bidirectional
// override characters are refused in every identifier-like string, so a value
// can never forge a log line or a report label.

import { AllocationError, type AllocationErrorCode } from './errors';

export const LIMITS = Object.freeze({
  /** Rows per allocation or tag-policy call. Callers chunk by tenant and month. */
  maxRows: 100_000,
  maxRules: 200,
  maxConditionsPerRule: 8,
  /** Values in one `oneOf` matcher, and in one allowed-value list. */
  maxListValues: 100,
  maxPools: 100,
  /** Targets in one pool policy. */
  maxPoolTargets: 500,
  maxTagsPerRow: 64,
  maxTagsJsonLength: 16_384,
  maxIdLength: 128,
  maxTenantLength: 64,
  maxAccountLength: 128,
  maxServiceLength: 128,
  maxRegionLength: 64,
  maxResourceIdLength: 512,
  maxTagKeyLength: 128,
  maxTagValueLength: 256,
  maxTargetIdLength: 128,
  maxMatcherValueLength: 256,
  /** Parts in one generic split. */
  maxSplitParts: 100_000,
  /** Periods held in one chargeback book. */
  maxPeriods: 240,
  /** Audit records held in one chargeback book. */
  maxAuditRecords: 10_000,
  /** How far an adjustment looks ahead for an open period, in months. */
  maxPeriodLookahead: 120,
  /** Tag policy entries. */
  maxPolicyKeys: 100,
  maxAllowedValues: 500,
  maxAliases: 500,
  /** Longest string compared by edit distance; longer strings get no typo suggestion. */
  maxEditDistanceLength: 64,
  /** Violations returned by a tag-policy evaluation (counts and totals stay exact). */
  maxViolationsReturned: 10_000,
  /** Kubernetes inputs. */
  maxK8sNodes: 5_000,
  maxK8sWorkloads: 100_000,
  maxK8sSharedCosts: 100,
  maxK8sGroups: 10_000,
  maxK8sLabels: 64,
  maxK8sShares: 1_000,
});

/** True for C0/C1 control characters, line and paragraph separators, and bidi override/isolate characters. */
export function hasUnsafeChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f) return true;
  }
  return false;
}

export interface TextOptions {
  /** Permit the empty string (default: refuse). */
  allowEmpty?: boolean;
  /** Refuse leading or trailing whitespace (default: true). Tag values pass false so governance can flag them. */
  requireTrimmed?: boolean;
}

/** Validates an untrusted string field. Throws the given code (fixed text) on any violation. */
export function checkText(
  value: unknown,
  max: number,
  code: AllocationErrorCode = 'INVALID_TEXT',
  opts: TextOptions = {},
  index?: number,
): string {
  if (typeof value !== 'string') throw new AllocationError(code, index);
  if (value.length === 0) {
    if (opts.allowEmpty) return value;
    throw new AllocationError(code, index);
  }
  if (value.length > max) throw new AllocationError(code, index);
  if (hasUnsafeChars(value)) throw new AllocationError(code, index);
  if ((opts.requireTrimmed ?? true) && value.trim() !== value) throw new AllocationError(code, index);
  return value;
}

/** Plain-object guard: not null, not an array, and a literal or null-prototype object (no class instances). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Reads an OWN property only, so an inherited or polluted prototype value is never mistaken for input. */
export function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Locale-independent code-unit comparison: the module's one deterministic ordering for keys. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
