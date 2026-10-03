// Worker commands of the CLI that need no database: argument validation,
// environment gates that must refuse BEFORE connecting, and leak checks.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { installProcessHandlers, main } from './cli';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

// Nothing listens on port 1: a connection attempt fails fast.
const UNREACHABLE = 'postgres://ratio_worker_login:WorkerSecretPw42@127.0.0.1:1/ratio_db';
const T = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const env = { RATIO_DATABASE_URL: UNREACHABLE };

async function run(argv: string[], e: Record<string, string | undefined> = env) {
  const c = capture();
  const code = await main(argv, e, c.io);
  return { code, ...c };
}

describe('worker CLI (no database)', () => {
  it('usage errors exit 2 and still print one evidence record', async () => {
    const cases: string[][] = [
      ['sync'],
      ['sync', '--tenant', T],
      ['sync', '--source', 'focus-main'],
      ['sync', '--tenant', 'not-a-uuid', '--source', 'focus-main'],
      ['sync', '--tenant', T, '--source', 'Bad Key!'],
      ['sync', '--tenant', T, '--source', 'focus-main', '--bogus'],
      ['backfill', '--tenant', T, '--source', 'focus-main'],
      ['backfill', '--tenant', T, '--source', 'focus-main', '--from', '2026-07', '--to', '2026-13'],
      ['backfill', '--tenant', T, '--source', 'focus-main', '--from', '2026-08', '--to', '2026-07'],
      ['backfill', '--tenant', T, '--source', 'focus-main', '--from', '2026-7', '--to', '2026-08'],
      ['replay', '--tenant', T, '--source', 'focus-main'],
      ['replay', '--tenant', T, '--source', 'focus-main', '--batch', B, '--period', '2026-07'],
      ['replay', '--tenant', T, '--source', 'focus-main', '--batch', 'nope'],
      ['quarantine', '--tenant', T, '--batch', B],
      ['quarantine', 'show', '--tenant', T],
      ['quarantine', 'show', '--batch', B],
      ['doctor', '--tenant', 'nope', '--json'],
      ['replay-fixtures', '--extra'],
    ];
    for (const argv of cases) {
      const r = await run(argv, { ...env, RATIO_ENV: 'test' });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.out, argv.join(' ')).toHaveLength(1);
      const rec = JSON.parse(r.out[0]);
      expect(rec).toMatchObject({ type: 'ratio.evidence', pass: false, exitCode: 2 });
      for (const line of r.err) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('missing RATIO_DATABASE_URL is a configuration error (exit 2)', async () => {
    const r = await run(['sync', '--tenant', T, '--source', 'focus-main'], {});
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/RATIO_DATABASE_URL/);
  });

  it('replay-fixtures is refused unless RATIO_ENV is staging or test, before connecting', async () => {
    for (const ratioEnv of [undefined, 'development', 'production', 'STAGING']) {
      const r = await run(['replay-fixtures', '--json'], { ...env, RATIO_ENV: ratioEnv });
      expect(r.code, String(ratioEnv)).toBe(2);
      const all = r.out.concat(r.err).join('\n');
      expect(all).toMatch(/REPLAY_FIXTURES_NOT_ALLOWED/);
      expect(all).not.toMatch(/ECONNREFUSED/);
    }
  });

  it('the test kill hook outside NODE_ENV=test refuses to start (before connecting)', async () => {
    const r = await run(['sync', '--tenant', T, '--source', 'focus-main'], { ...env, RATIO_TEST_PAUSE_AFTER_ROWS: '5', NODE_ENV: 'production' });
    expect(r.code).toBe(2);
    const all = r.out.concat(r.err).join('\n');
    expect(all).toMatch(/TEST_HOOK_NOT_ALLOWED/);
    expect(all).not.toMatch(/ECONNREFUSED/);
  });

  it('connection failures exit 1 and never echo the URL, user or password', async () => {
    for (const argv of [
      ['sync', '--tenant', T, '--source', 'focus-main'],
      ['backfill', '--tenant', T, '--source', 'focus-main', '--from', '2026-07', '--to', '2026-08'],
      ['replay', '--tenant', T, '--source', 'focus-main', '--batch', B],
      ['quarantine', 'show', '--tenant', T, '--batch', B, '--json'],
      ['doctor', '--json'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      const all = r.out.concat(r.err).join('\n');
      expect(all).not.toContain('WorkerSecretPw42');
      expect(all).not.toContain('ratio_worker_login');
      expect(all).not.toContain(UNREACHABLE);
      expect(r.out).toHaveLength(1);
      expect(JSON.parse(r.out[0])).toMatchObject({ type: 'ratio.evidence', pass: false, exitCode: 1 });
    }
  });

  it('doctor --json reports db_connectivity failure as a failed check', async () => {
    const r = await run(['doctor', '--json']);
    const rec = JSON.parse(r.out[0]);
    expect(rec.command).toBe('doctor');
    expect(rec.results.checks).toContainEqual(expect.objectContaining({ name: 'db_connectivity', status: 'fail' }));
  });

  it('unknown commands still exit 2 (Slice 0 contract unchanged)', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(2);
  });
});

describe('process-level crash handler (single implementation: cli.ts installProcessHandlers)', () => {
  const secret = 'pw"q\\b%22x';
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  // Worker secrets (not the migrate URL): the worker DB password and an S3 secret key.
  const env = {
    RATIO_DATABASE_URL: `postgres://worker_login:${encodeURIComponent(secret)}@127.0.0.1:1/db`,
    RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'S3-secret-key-value-that-must-not-print',
  };
  function install() {
    const proc = new EventEmitter();
    const err: string[] = [];
    const codes: number[] = [];
    installProcessHandlers(proc, env, { err: (l) => err.push(l) }, (c) => codes.push(c));
    return { proc, err, codes };
  }
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    it(`${event}: exactly one JSON line with worker secrets redacted, then exit 1`, () => {
      const { proc, err, codes } = install();
      proc.emit(event, Object.assign(new Error(`boom ${secret} and S3-secret-key-value-that-must-not-print`), { code: 'XX000' }));
      expect(err).toHaveLength(1);
      expect(JSON.parse(err[0])).toMatchObject({ level: 'error', event: `process.${event}` });
      for (const f of [...forms, 'S3-secret-key-value-that-must-not-print']) expect(err[0]).not.toContain(f);
      expect(codes).toEqual([1]);
    });
  }

  it('a reason whose toJSON throws (carrying worker secrets) yields the fixed fallback line and exit 1 (S11)', () => {
    const { proc, err, codes } = install();
    const evil = {
      toJSON() {
        throw new Error(`cannot serialize ${secret}`);
      },
    };
    expect(() => proc.emit('uncaughtException', evil)).not.toThrow();
    expect(err).toEqual(['{"error":"output redacted"}']);
    expect(codes).toEqual([1]);
  });

  it('a hostile reason (ownKeys trap that throws) yields the fixed fallback line and exit 1', () => {
    const { proc, err, codes } = install();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(`no keys ${secret}`);
        },
      },
    );
    expect(() => proc.emit('unhandledRejection', hostile)).not.toThrow();
    expect(err).toEqual(['{"error":"output redacted"}']);
    expect(codes).toEqual([1]);
  });

  it('a malformed RATIO_DATABASE_URL is a reported failure (exit 1, one evidence record), never a throw', async () => {
    const out: string[] = [];
    const code = await main(['sync', '--tenant', T, '--source', 'focus-main'], { RATIO_DATABASE_URL: 'postgres://u:p@[bad/db', RATIO_EVIDENCE_S3_BUCKET: 'ev-bucket' }, { out: (l) => out.push(l), err: () => undefined });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ type: 'ratio.evidence', pass: false, exitCode: 1 });
  });
});

// Spawned process, real handlers (as the CLI entry wires them): a crash whose
// message is over 2 MB must still yield exactly ONE redacted JSON line and
// exit 1, promptly — the handler must never block on redaction.
describe('crash handler in a spawned process with a > 2 MB message', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const CHILD = path.join(__dirname, 'testing', 'crashChild.ts');
  const secret = 'pw"q\\b%22x';
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), JSON.stringify(encodeURIComponent(secret)).slice(1, -1), 'S3-secret-key-crash-test'];
  const childEnv = (extra: Record<string, string>) => ({
    ...process.env,
    RATIO_DATABASE_URL: `postgres://worker_login:${encodeURIComponent(secret)}@127.0.0.1:1/db`,
    RATIO_MIGRATE_DATABASE_URL: `postgres://owner_login:${encodeURIComponent(secret)}@127.0.0.1:1/db`,
    RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'S3-secret-key-crash-test',
    RATIO_CRASH_SECRET: secret,
    ...extra,
  });
  const spawnChild = (extra: Record<string, string>) => {
    const started = Date.now();
    const r = spawnSync(TSX, [CHILD], { env: childEnv(extra), timeout: 20_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 << 20 });
    return { ...r, wallMs: Date.now() - started };
  };

  for (const mode of ['throw', 'reject'] as const) {
    it(`${mode === 'throw' ? 'uncaughtException' : 'unhandledRejection'}: one redacted line, exit 1, handler within 2 s of start-up`, () => {
      const baseline = spawnChild({ RATIO_CRASH_MODE: 'baseline' });
      expect(baseline.status, baseline.stderr).toBe(0);
      const r = spawnChild({ RATIO_CRASH_MODE: mode, RATIO_CRASH_BYTES: String(2_100_000) });
      expect(r.signal, `killed after ${r.wallMs} ms`).toBeNull();
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      const lines = r.stderr.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
      for (const f of forms) expect(lines[0], f).not.toContain(f);
      // The crash handling itself (beyond the child's start-up) stays within budget.
      expect(r.wallMs - baseline.wallMs).toBeLessThan(2_000);
    }, 60_000);
  }
});

