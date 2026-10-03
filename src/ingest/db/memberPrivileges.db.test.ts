// Round 16 (Copilot on 289db6a):
//   H1 — the extra-privilege scan for deployment logins (members of the ratio
//        roles) covered only `ratio` objects. A LOGIN member of ratio_worker
//        could be granted SET on session_replication_role (or database, FDW,
//        server, large-object, language, tablespace, type privileges) and pass.
//        Every transitive member of ratio_owner / ratio_worker / ratio_reader
//        is now scanned over EVERY category, like the ratio roles themselves.
//   H2 — ACL grantees were matched by exact OID / has_*_privilege on the
//        checked role only, so a privilege held by a SECOND role the member can
//        inherit from or SET ROLE to was missed. Every ACL-based check now
//        resolves each checked role's full upward membership closure.
// Roles, parameter ACLs and tablespace ACLs are cluster-global: everything
// here runs in a transaction that is ALWAYS rolled back. The committed
// real-login proof is in memberParameter.serial.db.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createTestDatabase } from './testing/harness';
import { privilegeModelViolations } from './privilegeModel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function inTxn(fn: (c: Client, name: (p: string) => string) => Promise<void>): Promise<void> {
  const db = await createTestDatabase({ migrate: true });
  cleanups.push(() => db.close());
  const c = new Client({ connectionString: db.url });
  c.on('error', () => undefined);
  await c.connect();
  cleanups.push(() => c.end());
  const sfx = Math.random().toString(16).slice(2, 10);
  await c.query('BEGIN');
  try {
    await fn(c, (p) => `ratio_probe_${p}_${sfx}`);
  } finally {
    await c.query('ROLLBACK');
  }
}

const problems = async (c: Client) => (await privilegeModelViolations(c)).join('\n');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One grant per privilege category, to `grantee`, and the privilege string the
 * check must report. `setup` creates what the grant needs (superuser, rolled back).
 */
const CATEGORIES: Array<{ cat: string; setup?: (c: Client, n: (p: string) => string) => Promise<void>; grant: (g: string, n: (p: string) => string) => string; priv: (n: (p: string) => string) => string }> = [
  {
    cat: 'parameter',
    grant: (g) => `GRANT SET ON PARAMETER session_replication_role TO ${g}`,
    priv: () => 'parameter:session_replication_role:SET',
  },
  {
    cat: 'database',
    grant: (g) => `DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${g}', current_database()); END $$`,
    priv: () => 'database:CREATE',
  },
  {
    cat: 'foreign-data wrapper',
    setup: async (c, n) => void (await c.query(`CREATE FOREIGN DATA WRAPPER ${n('fdw')}`)),
    grant: (g, n) => `GRANT USAGE ON FOREIGN DATA WRAPPER ${n('fdw')} TO ${g}`,
    priv: (n) => `foreign_data_wrapper:${n('fdw')}:USAGE`,
  },
  {
    cat: 'foreign server',
    setup: async (c, n) => {
      await c.query(`CREATE FOREIGN DATA WRAPPER ${n('fdw')}`);
      await c.query(`CREATE SERVER ${n('srv')} FOREIGN DATA WRAPPER ${n('fdw')}`);
    },
    grant: (g, n) => `GRANT USAGE ON FOREIGN SERVER ${n('srv')} TO ${g}`,
    priv: (n) => `foreign_server:${n('srv')}:USAGE`,
  },
  {
    cat: 'large object',
    setup: async (c) => void (await c.query(`SELECT pg_catalog.lo_create(434343)`)),
    grant: (g) => `GRANT SELECT ON LARGE OBJECT 434343 TO ${g}`,
    priv: () => 'large_object:434343:SELECT',
  },
  {
    cat: 'language',
    // PUBLIC holds USAGE on every language by default (the baseline); a grant
    // beyond PUBLIC is what is reported.
    setup: async (c) => void (await c.query(`REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC`)),
    grant: (g) => `GRANT USAGE ON LANGUAGE plpgsql TO ${g}`,
    priv: () => 'language:plpgsql:USAGE',
  },
  {
    cat: 'tablespace',
    grant: (g) => `GRANT CREATE ON TABLESPACE pg_default TO ${g}`,
    priv: () => 'tablespace:pg_default:CREATE',
  },
  {
    cat: 'type',
    setup: async (c, n) => {
      await c.query(`CREATE TYPE public.${n('t')} AS ENUM ('a')`);
      await c.query(`REVOKE USAGE ON TYPE public.${n('t')} FROM PUBLIC`);
    },
    grant: (g, n) => `GRANT USAGE ON TYPE public.${n('t')} TO ${g}`,
    priv: (n) => `type:public.${n('t')}:USAGE`,
  },
];

describe('round 16 H1: every privilege category is scanned for every (transitive) member of a ratio role', () => {
  for (const k of CATEGORIES) {
    for (const parent of ['ratio_worker', 'ratio_reader', 'ratio_owner'] as const) {
      if (k.cat === 'database' && parent === 'ratio_owner') {
        // Owner decision (round 16): the migrator may hold CREATE, CONNECT and
        // TEMPORARY on the database (CREATE SCHEMA needs CREATE) — an explicit
        // ALLOWED case rather than a skipped one (round 17, challenger L1).
        it('database: CREATE, CONNECT and TEMPORARY granted to a LOGIN member of ratio_owner are allowed (owner decision)', async () => {
          await inTxn(async (c, n) => {
            const login = n('m');
            await c.query(`CREATE ROLE ${login} LOGIN IN ROLE ratio_owner`);
            await c.query(
              `DO $$ BEGIN EXECUTE format('GRANT CREATE, CONNECT, TEMPORARY ON DATABASE %I TO ${login}', current_database()); END $$`,
            );
            const held = await c.query(
              `SELECT p FROM unnest(ARRAY['CREATE','CONNECT','TEMPORARY']) p WHERE has_database_privilege($1, current_database(), p)`,
              [login],
            );
            expect(held.rows.map((r) => r.p).sort()).toEqual(['CONNECT', 'CREATE', 'TEMPORARY']);
            expect((await privilegeModelViolations(c)).filter((x) => x.includes(login))).toEqual([]);
          });
        });
        continue;
      }
      it(`${k.cat}: a direct grant to a LOGIN member of ${parent} is refused`, async () => {
        await inTxn(async (c, n) => {
          const login = n('m');
          await c.query(`CREATE ROLE ${login} LOGIN IN ROLE ${parent}`);
          await k.setup?.(c, n);
          expect(await problems(c)).not.toMatch(new RegExp(`${login} holds`));
          await c.query(k.grant(login, n));
          expect(await problems(c)).toMatch(new RegExp(`${login} holds ${esc(k.priv(n))} beyond the reviewed set`));
        });
      });
    }
  }

  it('a transitive member (LOGIN member of a LOGIN member of ratio_worker) holding SET on session_replication_role is refused', async () => {
    await inTxn(async (c, n) => {
      const mid = n('mid');
      const leaf = n('leaf');
      await c.query(`CREATE ROLE ${mid} LOGIN IN ROLE ratio_worker`);
      await c.query(`CREATE ROLE ${leaf} LOGIN IN ROLE ${mid}`);
      await c.query(`GRANT SET ON PARAMETER session_replication_role TO ${leaf}`);
      expect(await problems(c)).toMatch(new RegExp(`${leaf} holds parameter:session_replication_role:SET beyond`));
    });
  });

  it('the ratio roles themselves: language, tablespace and type grants beyond PUBLIC are refused', async () => {
    await inTxn(async (c, n) => {
      await c.query(`GRANT CREATE ON TABLESPACE pg_default TO ratio_worker`);
      await c.query(`REVOKE USAGE ON LANGUAGE sql FROM PUBLIC`);
      await c.query(`GRANT USAGE ON LANGUAGE sql TO ratio_reader`);
      await c.query(`CREATE DOMAIN public.${n('d')} AS int`);
      await c.query(`REVOKE USAGE ON DOMAIN public.${n('d')} FROM PUBLIC`);
      await c.query(`GRANT USAGE ON DOMAIN public.${n('d')} TO ratio_worker`);
      const p = await problems(c);
      expect(p).toMatch(/ratio_worker holds tablespace:pg_default:CREATE beyond the reviewed set/);
      expect(p).toMatch(/ratio_reader holds language:sql:USAGE beyond the reviewed set/);
      expect(p).toMatch(new RegExp(`ratio_worker holds type:public\\.${n('d')}:USAGE beyond the reviewed set`));
    });
  });

  it('positive controls: plain members pass; the migrator (owner member) may hold CREATE on the database and own objects in ratio', async () => {
    await inTxn(async (c, n) => {
      const w = n('w');
      const r = n('r');
      const m = n('migrator');
      await c.query(`CREATE ROLE ${w} LOGIN IN ROLE ratio_worker`);
      await c.query(`CREATE ROLE ${r} LOGIN IN ROLE ratio_reader`);
      await c.query(`CREATE ROLE ${m} LOGIN CREATEROLE IN ROLE ratio_owner`);
      await c.query(`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${m}', current_database()); END $$`);
      expect((await privilegeModelViolations(c)).filter((x) => [w, r, m].some((who) => x.includes(who)))).toEqual([]);
    });
  });

  it('scope kept: a cluster role that is NOT a member of a ratio role is still checked on ratio objects only', async () => {
    await inTxn(async (c, n) => {
      const other = n('other');
      await c.query(`CREATE ROLE ${other} LOGIN`);
      await c.query(`GRANT SET ON PARAMETER session_replication_role TO ${other}`);
      await c.query(`GRANT CREATE ON TABLESPACE pg_default TO ${other}`);
      expect(await problems(c)).not.toMatch(new RegExp(other));
      await c.query(`GRANT USAGE ON SCHEMA ratio TO ${other}`);
      expect(await problems(c)).toMatch(new RegExp(`${other} holds schema:ratio:USAGE`));
    });
  });
});

describe('round 16 H2: privileges held through a SECOND role (inherit or SET ROLE) count for the member', () => {
  // app LOGIN IN ROLE ratio_reader, and ALSO a member of `cr` — with INHERIT
  // FALSE (SET ROLE only), so has_*_privilege(app, …) alone does not see it.
  for (const k of CATEGORIES) {
    it(`${k.cat}: a grant to a second role the member can SET ROLE to is refused`, async () => {
      await inTxn(async (c, n) => {
        const app = n('app');
        const cr = n('cr');
        await c.query(`CREATE ROLE ${cr} NOLOGIN`);
        await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_reader`);
        await c.query(`GRANT ${cr} TO ${app} WITH INHERIT FALSE, SET TRUE`);
        await k.setup?.(c, n);
        expect(await problems(c)).not.toMatch(new RegExp(`${app} holds`));
        await c.query(k.grant(cr, n));
        expect(await problems(c)).toMatch(new RegExp(`${app} holds ${esc(k.priv(n))} beyond the reviewed set`));
      });
    });
  }

  it('ratio objects: SELECT on ratio.cost_facts through a SET-ROLE-only second role is refused for the member', async () => {
    await inTxn(async (c, n) => {
      const app = n('app');
      const cr = n('cr');
      await c.query(`CREATE ROLE ${cr} NOLOGIN`);
      await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_reader`);
      await c.query(`GRANT ${cr} TO ${app} WITH INHERIT FALSE, SET TRUE`);
      await c.query(`GRANT USAGE ON SCHEMA ratio TO ${cr}`);
      await c.query(`GRANT SELECT ON ratio.cost_facts TO ${cr}`);
      expect(await problems(c)).toMatch(new RegExp(`${app} holds relation:ratio\\.cost_facts:SELECT beyond`));
    });
  });

  it('system schemas: an explicit ACL granted to a second role (default INHERIT) is attributed to the member', async () => {
    await inTxn(async (c, n) => {
      const app = n('app');
      const cr = n('catalog_reader');
      await c.query(`CREATE ROLE ${cr} NOLOGIN`);
      await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_reader, ${cr}`);
      await c.query(`GRANT SELECT ON pg_catalog.pg_authid TO ${cr}`);
      expect(await problems(c)).toMatch(new RegExp(`${app} holds explicit SELECT on pg_catalog\\.pg_authid \\(via ${cr}\\)`));
    });
  });

  it('system schemas: a column ACL granted to a SET-ROLE-only second role is attributed to the member', async () => {
    await inTxn(async (c, n) => {
      const app = n('app');
      const cr = n('cr');
      await c.query(`CREATE ROLE ${cr} NOLOGIN`);
      await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_worker`);
      await c.query(`GRANT ${cr} TO ${app} WITH INHERIT FALSE, SET TRUE`);
      await c.query(`GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO ${cr}`);
      expect(await problems(c)).toMatch(new RegExp(`${app} holds explicit SELECT\\(rolpassword\\) on pg_catalog\\.pg_authid \\(via ${cr}\\)`));
    });
  });

  it('a transitive chain: app → cr1 → cr2 (cr2 holds the grants) is attributed to app, for a catalog ACL and for a parameter', async () => {
    await inTxn(async (c, n) => {
      const app = n('app');
      const cr1 = n('cr1');
      const cr2 = n('cr2');
      await c.query(`CREATE ROLE ${cr2} NOLOGIN`);
      await c.query(`CREATE ROLE ${cr1} NOLOGIN`);
      await c.query(`GRANT ${cr2} TO ${cr1} WITH INHERIT FALSE, SET TRUE`);
      await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_worker`);
      await c.query(`GRANT ${cr1} TO ${app} WITH INHERIT FALSE, SET TRUE`);
      await c.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${cr2}`);
      await c.query(`GRANT SET ON PARAMETER session_replication_role TO ${cr2}`);
      const p = await problems(c);
      expect(p).toMatch(new RegExp(`${app} holds explicit EXECUTE on pg_catalog\\.pg_read_file\\(text\\) \\(via ${cr2}\\)`));
      expect(p).toMatch(new RegExp(`${app} holds parameter:session_replication_role:SET beyond`));
    });
  });

  it('a member that can SET ROLE to a SUPERUSER / BYPASSRLS role is refused; so is one in pg_read_server_files / pg_write_server_files / pg_execute_server_program', async () => {
    for (const [attr, parent] of [
      ['SUPERUSER', 'ratio_worker'],
      ['BYPASSRLS', 'ratio_reader'],
      ['REPLICATION', 'ratio_owner'],
    ] as const) {
      await inTxn(async (c, n) => {
        const app = n('app');
        const strong = n('strong');
        await c.query(`CREATE ROLE ${strong} NOLOGIN ${attr}`);
        await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ${parent}`);
        await c.query(`GRANT ${strong} TO ${app} WITH INHERIT FALSE, SET TRUE`);
        expect(await problems(c)).toMatch(new RegExp(`role ${app} \\(member of ${parent}\\) can assume ${strong}, which is ${attr}`));
      });
    }
    for (const pre of ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
      await inTxn(async (c, n) => {
        const app = n('app');
        await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_worker, ${pre}`);
        expect(await problems(c)).toMatch(new RegExp(`role ${app} \\(member of ratio_worker\\) can assume ${pre}`));
      });
    }
  });
});

describe('round 17 (challenger L2): more predefined roles are refused when reachable by a member, over ANY edge', () => {
  for (const pre of ['pg_read_all_data', 'pg_write_all_data', 'pg_signal_backend', 'pg_create_subscription']) {
    for (const parent of ['ratio_worker', 'ratio_reader', 'ratio_owner'] as const) {
      // ADMIN only (Copilot on #53, C1): with ADMIN OPTION a member can grant the role to itself, so it is assumable too.
      for (const edge of ['default', 'SET only', 'ADMIN only', 'transitive SET only'] as const) {
        it(`${pre}: a LOGIN member of ${parent} that can assume it (${edge} edge) is refused`, async () => {
          await inTxn(async (c, n) => {
            const app = n('app');
            await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ${parent}`);
            expect(await problems(c)).not.toMatch(new RegExp(`role ${app} .*can assume`));
            if (edge === 'default') await c.query(`GRANT ${pre} TO ${app}`);
            else if (edge === 'SET only') await c.query(`GRANT ${pre} TO ${app} WITH INHERIT FALSE, SET TRUE`);
            else if (edge === 'ADMIN only') await c.query(`GRANT ${pre} TO ${app} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
            else {
              const mid = n('mid');
              await c.query(`CREATE ROLE ${mid} NOLOGIN`);
              await c.query(`GRANT ${pre} TO ${mid} WITH INHERIT FALSE, SET TRUE`);
              await c.query(`GRANT ${mid} TO ${app} WITH INHERIT FALSE, SET TRUE`);
            }
            expect(await problems(c)).toMatch(new RegExp(`role ${app} \\(member of ${parent}\\) can assume ${pre}\\b`));
          });
        });
      }
    }
  }

  it('the round-16 server-file roles stay refused over a SET-only edge, for an owner member too', async () => {
    for (const pre of ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
      await inTxn(async (c, n) => {
        const app = n('app');
        await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ratio_owner`);
        await c.query(`GRANT ${pre} TO ${app} WITH INHERIT FALSE, SET TRUE`);
        expect(await problems(c)).toMatch(new RegExp(`role ${app} \\(member of ratio_owner\\) can assume ${pre}\\b`));
      });
    }
  });
});

describe('round 18: monitoring predefined roles are refused when reachable by a member, over ANY edge (explicit check, not the system-ACL footprint)', () => {
  // pg_read_all_stats shows every session's pg_stat_activity.query (other
  // tenants' statements and parameters); pg_read_all_settings every setting;
  // pg_monitor includes both. Only pg_monitor / pg_read_all_stats carry
  // pg_catalog ACL entries, so the system-ACL scan alone would miss
  // pg_read_all_settings and depends on PostgreSQL's catalog grants.
  for (const pre of ['pg_monitor', 'pg_read_all_stats', 'pg_read_all_settings', 'pg_stat_scan_tables']) {
    for (const parent of ['ratio_worker', 'ratio_reader', 'ratio_owner'] as const) {
      // ADMIN only (Copilot on #53, C1): with ADMIN OPTION a member can grant the role to itself, so it is assumable too.
      for (const edge of ['default', 'SET only', 'ADMIN only', 'transitive SET only'] as const) {
        it(`${pre}: a LOGIN member of ${parent} that can assume it (${edge} edge) is refused`, async () => {
          await inTxn(async (c, n) => {
            const app = n('app');
            await c.query(`CREATE ROLE ${app} LOGIN IN ROLE ${parent}`);
            expect(await problems(c)).not.toMatch(new RegExp(`${app}`));
            if (edge === 'default') await c.query(`GRANT ${pre} TO ${app}`);
            else if (edge === 'SET only') await c.query(`GRANT ${pre} TO ${app} WITH INHERIT FALSE, SET TRUE`);
            else if (edge === 'ADMIN only') await c.query(`GRANT ${pre} TO ${app} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
            else {
              const mid = n('mid');
              await c.query(`CREATE ROLE ${mid} NOLOGIN`);
              await c.query(`GRANT ${pre} TO ${mid} WITH INHERIT FALSE, SET TRUE`);
              await c.query(`GRANT ${mid} TO ${app} WITH INHERIT FALSE, SET TRUE`);
            }
            expect(await problems(c)).toMatch(new RegExp(`role ${app} \\(member of ${parent}\\) can assume ${pre}\\b`));
          });
        });
      }
    }
  }
});
