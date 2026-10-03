// #4 timezone independence: FOCUS date parsing must not depend on the server's
// local zone. This file runs in its own worker with TZ=America/Los_Angeles.

process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { validateFocusRecords } from './focusExport';

function start(v: unknown): string {
  return validateFocusRecords([{ BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: v }], 'feed')[0]
    .ChargePeriodStart;
}

describe('FOCUS dates under TZ=America/Los_Angeles', () => {
  it('the process really is in a non-UTC zone', () => {
    expect(new Date('2026-06-01T00:00:00').getTimezoneOffset()).toBe(420);
  });

  it('an offset-less timestamp is read as UTC, not server-local', () => {
    expect(start('2026-06-01T10:00:00')).toBe('2026-06-01T10:00:00.000Z');
    expect(start('2026-06-01 10:00:00')).toBe('2026-06-01T10:00:00.000Z');
  });

  it('a date-only value is midnight UTC', () => {
    expect(start('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
  });

  it('explicit offsets are honoured', () => {
    expect(start('2026-06-01T10:00:00-07:00')).toBe('2026-06-01T17:00:00.000Z');
    expect(start('2026-06-01T10:00:00Z')).toBe('2026-06-01T10:00:00.000Z');
  });
});
