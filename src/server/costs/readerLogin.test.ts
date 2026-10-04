// Reader-login check: refusal reasons as fixed CODES (logged instead of the
// problem texts, which can name roles), and the LOGIN-disabled rule
// (challenger Lows 2 and 3). Fake catalog answers; the live behaviour is in
// publishedCosts.db.test.ts / .serial.db.test.ts.
import { describe, expect, it } from 'vitest';
import { readerLoginReport, assertSafeReaderLogin, UnsafeReaderLoginError } from './readerLogin';

interface Catalog {
  superuser?: boolean;
  bypass?: boolean;
  privileged?: boolean;
  unsafe?: string[];
  owner?: boolean;
  reader?: boolean;
  worker?: boolean;
  canLogin?: boolean;
}

/** A fake client answering Slice 1's inspectRole query and the reader query. */
function client(c: Catalog) {
  return {
    async query(sql: string) {
      if (sql.includes('connected_roles')) {
        return {
          rows: [
            {
              cu: 'login_x',
              su: 'login_x',
              superuser: c.superuser ?? false,
              bypass: c.bypass ?? false,
              privileged: c.privileged ?? false,
              unsafe_capabilities: c.unsafe ?? [],
              owner_member: c.owner ?? false,
              worker_member: false,
            },
          ],
        };
      }
      return { rows: [{ reader: c.reader ?? true, worker: c.worker ?? false, can_login: c.canLogin ?? true }] };
    },
  } as never;
}

describe('reader-login reason codes', () => {
  it('a safe reader has no problem and no reason', async () => {
    expect(await readerLoginReport(client({}))).toEqual({ problems: [], reasons: [] });
  });

  const cases: Array<[string, Catalog, string[]]> = [
    ['superuser', { superuser: true, privileged: true, unsafe: ['SUPERUSER'] }, ['SUPERUSER']],
    ['BYPASSRLS', { bypass: true, privileged: true, unsafe: ['BYPASSRLS'] }, ['BYPASSRLS']],
    ['a reachable superuser role', { privileged: true, unsafe: ['SUPERUSER'] }, ['PRIVILEGED_ROLE_REACHABLE']],
    ['REPLICATION / CREATEROLE / CREATEDB', { unsafe: ['CREATEDB', 'CREATEROLE', 'REPLICATION'] }, ['UNSAFE_ATTRIBUTE']],
    ['a refused predefined role', { unsafe: ['pg_monitor', 'pg_read_all_data'] }, ['REFUSED_PREDEFINED_ROLE']],
    ['ratio_owner member', { owner: true }, ['OWNER_MEMBER']],
    ['not an inheriting reader', { reader: false }, ['NOT_READER_MEMBER']],
    ['can reach ratio_worker', { worker: true }, ['WORKER_REACHABLE']],
    ['LOGIN disabled (NOLOGIN) while pooled', { canLogin: false }, ['LOGIN_DISABLED']],
  ];
  for (const [name, catalog, reasons] of cases) {
    it(`${name} ⇒ ${reasons.join(', ')}`, async () => {
      const r = await readerLoginReport(client(catalog));
      expect(r.reasons).toEqual(reasons);
      expect(r.problems.length).toBeGreaterThan(0);
      // Codes never carry a role name.
      expect(r.reasons.join(' ')).not.toMatch(/pg_|ratio_|login_x/);
    });
  }

  it('several problems ⇒ several codes, in a stable order', async () => {
    const r = await readerLoginReport(client({ owner: true, worker: true, canLogin: false, unsafe: ['pg_signal_backend'] }));
    expect(r.reasons).toEqual(['REFUSED_PREDEFINED_ROLE', 'OWNER_MEMBER', 'WORKER_REACHABLE', 'LOGIN_DISABLED']);
  });

  it('assertSafeReaderLogin throws UnsafeReaderLoginError carrying problems and codes', async () => {
    const e = await assertSafeReaderLogin(client({ canLogin: false })).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(UnsafeReaderLoginError);
    expect((e as UnsafeReaderLoginError).reasons).toEqual(['LOGIN_DISABLED']);
    expect((e as UnsafeReaderLoginError).code).toBe('UNSAFE_DB_LOGIN');
  });
});
