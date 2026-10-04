// Issue #62, orchestrator decision on challenger L3 (2026-10-04):
// replay-fixtures ingests the SYNTHETIC fixture, whose provider names are
// accepted only in development/test. It is therefore TEST-ONLY: RATIO_ENV=staging
// (and every other value but `test`) fails closed BEFORE any I/O, exit 2,
// naming the reason. Per-source synthetic markers (D-21, Slice 3) are the way to
// restore staging later. There is no in-code opt-in bypass.
import { describe, expect, it } from 'vitest';
import { main } from './cli';

// Nothing listens on port 1: an attempted connection would show as ECONNREFUSED.
const UNREACHABLE = 'postgres://ratio_worker_login:WorkerSecretPw42@127.0.0.1:1/ratio_db';
const env = { RATIO_DATABASE_URL: UNREACHABLE, RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_REPLAY_FIXTURES_BUCKET: 'ratio-fixtures-scratch' };
const REASON =
  'replay-fixtures runs only when RATIO_ENV is test: it ingests synthetic providers, which are allowed only in development/test (per-source synthetic markers are tracked as D-21 for Slice 3)';

async function run(argv: string[], e: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, all: out.concat(err).join('\n') };
}

describe('replay-fixtures is test-only (L3 decision)', () => {
  it('RATIO_ENV=staging fails closed before any I/O: exit 2, REPLAY_FIXTURES_NOT_ALLOWED, the reason named', async () => {
    for (const extra of [{}, { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' }, { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '0' }]) {
      const r = await run(['replay-fixtures', '--json'], { ...env, ...extra, RATIO_ENV: 'staging' });
      expect(r.code, JSON.stringify(extra)).toBe(2);
      const rec = JSON.parse(r.out[0]);
      expect(rec).toMatchObject({ command: 'replay-fixtures', pass: false, exitCode: 2, results: { error: { code: 'REPLAY_FIXTURES_NOT_ALLOWED', message: REASON } } });
      expect(r.all).not.toMatch(/ECONNREFUSED|config\.synthetic_providers_allowed/);
    }
  });

  it('every RATIO_ENV but test is refused the same way (development, production, unset, other casing)', async () => {
    for (const ratioEnv of [undefined, '', 'development', 'production', 'STAGING', 'Test', ' staging']) {
      const r = await run(['replay-fixtures', '--json'], { ...env, RATIO_ENV: ratioEnv });
      expect(r.code, String(ratioEnv)).toBe(2);
      expect(JSON.parse(r.out[0]).results.error, String(ratioEnv)).toEqual({ code: 'REPLAY_FIXTURES_NOT_ALLOWED', message: REASON });
      expect(r.all).not.toMatch(/ECONNREFUSED/);
    }
  });

  it('RATIO_ENV=test passes the gate (it then fails only on the unreachable database, i.e. after the gate)', async () => {
    const r = await run(['replay-fixtures', '--json'], { ...env, RATIO_ENV: 'test', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' });
    expect(r.all).not.toMatch(/REPLAY_FIXTURES_NOT_ALLOWED/);
    expect(r.code).not.toBe(0);
  });
});
