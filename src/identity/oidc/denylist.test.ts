// Checklist 1.4: the in-memory jti denylist, the reference implementation of the
// verifier's revocation hook. Bounded, fail-closed when full, and expiring.

import { describe, expect, it } from 'vitest';
import { MAX_DENYLIST_ENTRIES, OidcError, createMemoryJtiDenylist, type OidcErrorCode } from './index';

const NOW = 1_800_000_000;
function make(maxEntries = 3) {
  const clock = { t: NOW };
  return { clock, list: createMemoryJtiDenylist({ maxEntries, clock: () => clock.t }) };
}
function codeOf(fn: () => unknown): OidcErrorCode | 'no-throw' | 'other' {
  try {
    fn();
  } catch (e) {
    return e instanceof OidcError ? e.code : 'other';
  }
  return 'no-throw';
}

describe('revocation and expiry', () => {
  it('reports a revoked id as revoked and any other id as not', async () => {
    const { list } = make();
    list.revoke('a', NOW + 100);
    await expect(list.isRevoked('a')).resolves.toBe(true);
    await expect(list.isRevoked('b')).resolves.toBe(false);
    await expect(list.isRevoked('')).resolves.toBe(false);
  });

  it('answers in the shape the verifier hook expects: a promise of a boolean', async () => {
    const { list } = make();
    const p = list.isRevoked('a');
    expect(p).toBeInstanceOf(Promise);
    expect(typeof (await p)).toBe('boolean');
  });

  it('forgets a revocation once its retention time has passed (boundary)', async () => {
    const { list, clock } = make();
    list.revoke('a', NOW + 100);
    clock.t = NOW + 99;
    await expect(list.isRevoked('a')).resolves.toBe(true);
    clock.t = NOW + 100;
    await expect(list.isRevoked('a')).resolves.toBe(false);
  });

  it('keeps the later retention time when an id is revoked twice, never the earlier', async () => {
    const { list, clock } = make();
    list.revoke('a', NOW + 100);
    list.revoke('a', NOW + 50);
    clock.t = NOW + 99;
    await expect(list.isRevoked('a')).resolves.toBe(true);
    list.revoke('a', NOW + 500);
    clock.t = NOW + 400;
    await expect(list.isRevoked('a')).resolves.toBe(true);
    expect(list.size).toBe(1);
  });

  it('does not treat prototype-looking ids as revoked', async () => {
    const { list } = make();
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) await expect(list.isRevoked(id)).resolves.toBe(false);
  });

  it('never throws from isRevoked on odd input', async () => {
    const { list } = make();
    for (const v of [undefined, null, 5, {}, []]) await expect(list.isRevoked(v as never)).resolves.toBe(false);
  });
});

describe('capacity', () => {
  it('holds exactly maxEntries live revocations and refuses the next one without evicting', async () => {
    const { list } = make(3);
    list.revoke('a', NOW + 100);
    list.revoke('b', NOW + 100);
    list.revoke('c', NOW + 100);
    expect(codeOf(() => list.revoke('d', NOW + 100))).toBe('capacity');
    expect(list.size).toBe(3);
    for (const id of ['a', 'b', 'c']) await expect(list.isRevoked(id)).resolves.toBe(true); // nothing was un-revoked
    await expect(list.isRevoked('d')).resolves.toBe(false);
  });

  it('makes room by dropping only expired entries', async () => {
    const { list, clock } = make(3);
    list.revoke('a', NOW + 10);
    list.revoke('b', NOW + 100);
    list.revoke('c', NOW + 100);
    clock.t = NOW + 10;
    list.revoke('d', NOW + 200);
    expect(list.size).toBe(3);
    await expect(list.isRevoked('a')).resolves.toBe(false);
    await expect(list.isRevoked('d')).resolves.toBe(true);
  });

  it('lets a full list extend an existing entry', () => {
    const { list } = make(2);
    list.revoke('a', NOW + 10);
    list.revoke('b', NOW + 10);
    expect(codeOf(() => list.revoke('a', NOW + 500))).toBe('no-throw');
    expect(list.size).toBe(2);
  });

  it('supports a capacity of one', () => {
    const { list } = make(1);
    list.revoke('a', NOW + 10);
    expect(codeOf(() => list.revoke('b', NOW + 10))).toBe('capacity');
  });
});

describe('input validation', () => {
  it.each([[''], [' '], ['has space'], ['a'.repeat(129)], [5], [null], [undefined], [{}]])('refuses the jti %j', (jti) => {
    const { list } = make();
    expect(codeOf(() => list.revoke(jti as string, NOW + 10))).toBe('invalid_input');
    expect(list.size).toBe(0);
  });
  it.each([[0], [-1], [1.5], [Number.NaN], [Infinity], ['100'], [null], [undefined]])('refuses the retention time %j', (until) => {
    const { list } = make();
    expect(codeOf(() => list.revoke('a', until as number))).toBe('invalid_input');
  });
  it('accepts a jti of exactly 128 characters', () => {
    const { list } = make();
    expect(codeOf(() => list.revoke('j'.repeat(128), NOW + 10))).toBe('no-throw');
  });
  it('refuses bad options with a fixed config error', () => {
    for (const maxEntries of [0, -1, 1.5, MAX_DENYLIST_ENTRIES + 1, '5', undefined, Number.NaN]) {
      expect(codeOf(() => createMemoryJtiDenylist({ maxEntries: maxEntries as number }))).toBe('invalid_config');
    }
    expect(codeOf(() => createMemoryJtiDenylist({ maxEntries: 5, clock: 'x' as never }))).toBe('invalid_config');
    expect(codeOf(() => createMemoryJtiDenylist(undefined as never))).toBe('invalid_config');
    expect(codeOf(() => createMemoryJtiDenylist({ maxEntries: MAX_DENYLIST_ENTRIES }))).toBe('no-throw');
  });
  it('uses the wall clock by default', async () => {
    const list = createMemoryJtiDenylist({ maxEntries: 2 });
    list.revoke('a', Math.floor(Date.now() / 1000) + 3600);
    await expect(list.isRevoked('a')).resolves.toBe(true);
  });
});
