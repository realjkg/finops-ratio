// FOCUS conformance checks for rows crossing the A2A boundary.
//
// The FinIO spec states what makes a row valid but nothing in the repo enforced
// it, so a malformed row could be emitted to a peer — or accepted from one —
// without complaint. These are the checks the spec names, plus the R4 invariant
// the repo treats as non-negotiable: a cost never travels without its value
// denominator attached.
//
// Deliberately pure and dependency-free: the same function guards the export
// route, the mock client, and the tests.

import type { FocusRow } from './FinioClient';

export type FocusRowValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parses an ISO 8601 timestamp, returning null when unparseable. */
function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validates one FOCUS row against the mandatory-column rules.
 *
 * Checks, in order:
 *  - BilledCost and EffectiveCost are non-null finite numbers (FOCUS makes
 *    BilledCost a mandatory, non-null decimal metric).
 *  - BillingCurrency is a non-empty string.
 *  - BillingPeriodStart < BillingPeriodEnd, and likewise for the charge period
 *    (FOCUS periods are half-open ranges, so equal bounds are invalid).
 *  - The Ratio value extensions are present and numeric (R4).
 */
export function validateFocusRow(row: FocusRow): FocusRowValidation {
  const errors: string[] = [];

  if (!isFiniteNumber(row.BilledCost)) {
    errors.push('BilledCost must be a non-null finite number');
  }
  if (!isFiniteNumber(row.EffectiveCost)) {
    errors.push('EffectiveCost must be a non-null finite number');
  }
  if (typeof row.BillingCurrency !== 'string' || row.BillingCurrency.length === 0) {
    errors.push('BillingCurrency must be a non-empty string');
  }

  const periods: Array<[string, unknown, unknown]> = [
    ['Billing', row.BillingPeriodStart, row.BillingPeriodEnd],
    ['Charge', row.ChargePeriodStart, row.ChargePeriodEnd],
  ];
  for (const [label, rawStart, rawEnd] of periods) {
    const start = parseIso(rawStart);
    const end = parseIso(rawEnd);
    if (start === null) {
      errors.push(`${label}PeriodStart must be an ISO 8601 timestamp`);
    }
    if (end === null) {
      errors.push(`${label}PeriodEnd must be an ISO 8601 timestamp`);
    }
    if (start !== null && end !== null && start >= end) {
      errors.push(`${label}PeriodStart must be strictly before ${label}PeriodEnd`);
    }
  }

  // R4 — cost without value is just spend. A row that lost its denominator in
  // transit is not a FinIO row, whatever its cost columns say.
  if (typeof row.x_RatioWorkloadId !== 'string') {
    errors.push('x_RatioWorkloadId must be a string');
  }
  if (!isFiniteNumber(row.x_RatioValueRatio)) {
    errors.push('x_RatioValueRatio must be a finite number');
  }
  if (!isFiniteNumber(row.x_RatioTotalValue)) {
    errors.push('x_RatioTotalValue must be a finite number');
  }
  if (
    !isFiniteNumber(row.x_RatioGovernanceGates) ||
    row.x_RatioGovernanceGates < 0 ||
    row.x_RatioGovernanceGates > 4
  ) {
    errors.push('x_RatioGovernanceGates must be a number between 0 and 4');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Validates a batch, reporting the row index alongside each failure. */
export function validateFocusRows(rows: FocusRow[]): FocusRowValidation {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    const result = validateFocusRow(row);
    if (!result.ok) errors.push(...result.errors.map((e) => `row[${i}]: ${e}`));
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
