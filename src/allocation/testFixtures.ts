// Shared builders for the allocation test suites. Test-only: nothing in the
// production modules imports this file. No clock, no randomness, no I/O.

import type { AllocatableRow } from './rows';
import type { CostRule } from './rules';

export const TENANT = 'tenant-a';

let counter = 0;

/** Resets the id counter so each test file starts from the same ids. */
export function resetIds(): void {
  counter = 0;
}

export function row(over: Partial<AllocatableRow> = {}): AllocatableRow {
  counter += 1;
  return {
    id: `row-${counter}`,
    tenant: TENANT,
    currency: 'USD',
    amount: '10.00',
    periodStart: '2026-03-01T00:00:00Z',
    account: 'acct-1',
    service: 'AmazonEC2',
    tags: {},
    ...over,
  };
}

/** A rule that sends rows with `tag=value` to a team. */
export function tagRule(id: string, precedence: number, key: string, value: string, team: string): CostRule {
  return {
    id,
    precedence,
    when: [{ field: 'tag', key, match: { op: 'equals', value } }],
    action: { kind: 'target', target: { team } },
  };
}

/** Deterministic PRNG (mulberry32). Test suites that need randomness pass a fixed seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON.stringify that survives bigint, for structural equality checks on reports. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v));
}
