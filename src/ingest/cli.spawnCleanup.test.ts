// Children spawned by the test helpers (testing/cli.ts: spawnCli, trackChild)
// must never outlive the test file, even when an assertion fails mid-way: the
// registry kills every live child in afterAll. Proven end to end by running a
// fixture file whose test fails while its child is running, in a nested
// vitest, then checking that the child's pid is gone.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_CONFIG = path.join(__dirname, 'testing', 'spawnFixture', 'vitest.config.ts');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawned test children are killed when the file ends (even after a failed assertion)', () => {
  it('the fixture fails mid-way, and its running child is gone afterwards', () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-orphan-')), 'pid');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', FIXTURE_CONFIG], {
      cwd: ROOT,
      env: { ...process.env, RATIO_ORPHAN_PID_FILE: pidFile },
      encoding: 'utf8',
      timeout: 60_000,
    });
    // The fixture's assertion failed (that is the scenario) ...
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/the assertion that fails mid-way/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // ... yet its child does not outlive the file.
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, 'SIGKILL'); // never leave it running, even when this test fails
    expect(stillAlive, `child ${pid} outlived the failed test file`).toBe(false);
  }, 90_000);
});
