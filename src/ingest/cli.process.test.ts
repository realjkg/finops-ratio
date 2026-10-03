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

describe('built CLI crash path (piped stderr)', () => {
  for (const kind of ['uncaught', 'rejection'] as const) {
    it(`${kind}: exactly one redacted JSON line arrives on stderr and the exit code is 1 (large payload)`, () => {
      // The pad makes the line larger than a pipe buffer: an async write followed by exit() would truncate or lose it.
      const r = runCli({ RATIO_ENV: 'test', RATIO_TEST_CRASH: kind, RATIO_TEST_CRASH_PAD: '2000000' });
      expect(r.status, r.stderr.slice(0, 300)).toBe(1);
      const lines = r.stderr.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const doc = JSON.parse(lines[0]);
      expect(doc).toMatchObject({ level: 'error', event: kind === 'uncaught' ? 'process.uncaughtException' : 'process.unhandledRejection' });
      expect(lines[0].length).toBeGreaterThan(2_000_000);
      for (const f of [PASSWORD, encodeURIComponent(PASSWORD), JSON.stringify(PASSWORD).slice(1, -1), 'ratio_user']) expect(lines[0]).not.toContain(f);
      expect(lines[0]).toContain('[redacted]');
    });
  }

  it('the crash hook is refused outside RATIO_ENV=test (staging, production, unset): no process.* line', () => {
    for (const env of [{ RATIO_ENV: 'staging' }, { RATIO_ENV: 'production' }, { RATIO_ENV: 'test', NODE_ENV: 'production' }, {}] as Array<Record<string, string>>) {
      const r = runCli({ ...env, RATIO_TEST_CRASH: 'uncaught' });
      const all = (r.stdout ?? '') + (r.stderr ?? '');
      expect(all, JSON.stringify(env)).not.toMatch(/process\.uncaughtException/);
      expect(all).toMatch(/migrate\.failed/); // the normal path ran (and failed to connect to port 1)
      expect(r.status).toBe(1);
      expect(all).not.toContain('SuperSecretPw9');
    }
  });
});
