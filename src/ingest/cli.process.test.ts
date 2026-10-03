// Round 14 (Copilot M1): the crash handler of the BUILT CLI must deliver its
// one redacted JSON line through a POSIX pipe before exiting. The CLI is
// compiled (worker tsconfig) into node_modules/.cache so `pg` still resolves,
// spawned with stderr piped, and crashed through a test-only hook that the CLI
// honours only when RATIO_ENV=test (never in staging or production).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'node_modules', '.cache', `ratio-cli-process-test-${process.pid}`);
const CLI = path.join(OUT, 'ingest', 'cli.js');
const PASSWORD = 'SuperSecretPw9"x';
const URL = `postgres://ratio_user:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/ratio_db`;

beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'tsconfig.worker.json'), '--outDir', OUT], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  // Same as `npm run worker:build`: the migrations (and their manifests) ship next to the runner.
  fs.cpSync(path.join(ROOT, 'src', 'ingest', 'db', 'migrations'), path.join(OUT, 'ingest', 'db', 'migrations'), { recursive: true });
}, 180_000);
afterAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
});

function runCli(env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, 'migrate'], {
    env: { PATH: process.env.PATH ?? '', RATIO_MIGRATE_DATABASE_URL: URL, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
}

// Each case spawns the built CLI (four times for the refusal case). Process
// start-up alone can exceed vitest's 5 s default on a loaded host, so the
// timeout is explicit (round 16; same budget as each spawnSync below).
const SPAWN_TIMEOUT_MS = 60_000;

describe('built CLI crash path (piped stderr)', () => {
  for (const kind of ['uncaught', 'rejection'] as const) {
    it(`${kind}: exactly one redacted JSON line arrives on stderr and the exit code is 1 (large payload)`, () => {
      // A > 2 MB error message. Since the Slice 1 merge every string is capped
      // BEFORE redaction (reviewed design: bounded, linear redaction), so the
      // line is small, redacted and marked truncated; the > 2 MB pipe delivery
      // of writeAllSync itself is tested separately below.
      const r = runCli({ RATIO_ENV: 'test', RATIO_TEST_CRASH: kind, RATIO_TEST_CRASH_PAD: '2000000' });
      expect(r.status, r.stderr.slice(0, 300)).toBe(1);
      const lines = r.stderr.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const doc = JSON.parse(lines[0]);
      expect(doc).toMatchObject({ level: 'error', event: kind === 'uncaught' ? 'process.uncaughtException' : 'process.unhandledRejection' });
      expect(lines[0].length).toBeLessThan(16_384);
      expect(doc.error.message).toContain('…[TRUNCATED]');
      for (const f of [PASSWORD, encodeURIComponent(PASSWORD), JSON.stringify(PASSWORD).slice(1, -1), 'ratio_user']) expect(lines[0]).not.toContain(f);
      expect(lines[0]).toContain('[redacted]');
    }, SPAWN_TIMEOUT_MS);
  }

  it('writeAllSync delivers a > 2 MB line through a pipe even when process.exit() follows immediately', () => {
    // The original intent of the large-payload case (round 14): a synchronous,
    // EAGAIN-retrying write to fd 2, so nothing is lost on a pipe before exit().
    const script = `const { writeAllSync } = require(${JSON.stringify(CLI)}); writeAllSync(2, 'x'.repeat(2_100_000) + '\\n'); process.exit(1);`;
    const r = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr.length).toBe(2_100_001);
    expect(r.stderr.endsWith('x\n')).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('the crash hook is refused outside RATIO_ENV=test (staging, production, unset): no process.* line', () => {
    for (const env of [{ RATIO_ENV: 'staging' }, { RATIO_ENV: 'production' }, { RATIO_ENV: 'test', NODE_ENV: 'production' }, {}] as Array<Record<string, string>>) {
      const r = runCli({ ...env, RATIO_TEST_CRASH: 'uncaught' });
      const all = (r.stdout ?? '') + (r.stderr ?? '');
      expect(all, JSON.stringify(env)).not.toMatch(/process\.uncaughtException/);
      expect(all).toMatch(/migrate\.failed/); // the normal path ran (and failed to connect to port 1)
      expect(r.status).toBe(1);
      expect(all).not.toContain('SuperSecretPw9');
    }
  }, SPAWN_TIMEOUT_MS); // four sequential spawns
});
