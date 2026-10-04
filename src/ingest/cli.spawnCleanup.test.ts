// Children spawned by the test helpers (testing/cli.ts: spawnCli, trackChild)
// must never outlive the test file, even when an assertion fails mid-way: the
// registry kills every live child in afterAll. Proven end to end by running a
// fixture file whose test fails while its child is running, in a nested
// vitest, then checking that the child's pid is gone.
//
// The nested run itself must not leak either, even when it is INTERRUPTED
// (killed before any afterAll runs): it is spawned detached (its own process
// group) and, whatever happens, the parent kills that group and every process
// carrying this run's env marker. The fixture child also exits by itself
// after 120 s.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_CONFIG = path.join(__dirname, 'testing', 'spawnFixture', 'vitest.config.ts');

/** /proc/<pid>/stat fields after the command name: [state, ppid, pgrp, ...]; null when the process is gone. */
function statFields(pid: number): string[] | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return null;
  }
}

/**
 * Running. Gone, a zombie ('Z': exited, never reaped — e.g. an orphan under a
 * PID 1 that does not reap) and dead ('X') all count as dead.
 */
function alive(pid: number): boolean {
  const f = statFields(pid);
  return f !== null && f[0] !== 'Z' && f[0] !== 'X';
}

/** Live members of a process group (Linux /proc). */
function pidsInGroup(pgid: number): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    const f = statFields(Number(d));
    if (f && Number(f[2]) === pgid && alive(Number(d))) out.push(Number(d));
  }
  return out;
}

/** Pids of live processes whose environment carries RATIO_ORPHAN_MARKER=<marker> (Linux /proc). */
export function pidsWithMarker(marker: string): number[] {
  const needle = `RATIO_ORPHAN_MARKER=${marker}`;
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(needle)) out.push(Number(d));
    } catch {
      // gone or not ours
    }
  }
  return out;
}

/**
 * Kills the nested run's process group and every process with the marker, then
 * CONFIRMS they are dead (gone or zombie): SIGKILL is asynchronous — right
 * after kill() returns the target can still show as running until the kernel
 * schedules its exit (CI #54, run 37157034669). Re-kills and polls until
 * nothing is left or `timeoutMs` passes; returns what is still alive (empty on
 * success).
 */
export async function reap(groupLeader: number | undefined, marker: string, timeoutMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  const killed = new Set<number>();
  for (;;) {
    if (groupLeader) {
      try {
        process.kill(-groupLeader, 'SIGKILL');
      } catch {
        // group already gone
      }
      for (const pid of pidsInGroup(groupLeader)) killed.add(pid);
    }
    for (const pid of pidsWithMarker(marker)) {
      killed.add(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    const living = [...killed].filter(alive);
    if (living.length === 0 && pidsWithMarker(marker).length === 0) return [];
    if (Date.now() >= deadline) return living;
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface FixtureRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  pid: number;
  marker: string;
  aliveBeforeReap: boolean;
  /** What reap() could not confirm dead within its bound (must be empty). */
  leftAfterReap: number[];
}

/**
 * Runs the fixture in a nested vitest, DETACHED (its own process group). On
 * timeout only the nested vitest main process is SIGKILLed (an interrupted
 * run: no afterAll runs, workers and children are orphaned). Whatever
 * happens, the group and every process carrying this run's marker are reaped
 * before returning.
 */
async function runFixture(extraEnv: Record<string, string>, timeoutMs: number): Promise<FixtureRun> {
  const marker = crypto.randomBytes(8).toString('hex');
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-orphan-')), 'pid');
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', FIXTURE_CONFIG], {
    cwd: ROOT,
    env: { ...process.env, RATIO_ORPHAN_PID_FILE: pidFile, RATIO_ORPHAN_MARKER: marker, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout!.on('data', (d: Buffer) => (output += d.toString('utf8')));
  child.stderr!.on('data', (d: Buffer) => (output += d.toString('utf8')));
  try {
    const { status, signal } = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const timer = setTimeout(() => {
        try {
          // Interrupt: kill only the nested vitest MAIN process (like a killed CI step) —
          // no afterAll runs, its workers and their children are orphaned unless reaped.
          process.kill(child.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
      }, timeoutMs);
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        resolve({ status: code, signal: sig });
      });
    });
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    const aliveBeforeReap = pid > 0 && alive(pid);
    const leftAfterReap = await reap(child.pid, marker);
    return { status, signal, output, pid, marker, aliveBeforeReap, leftAfterReap };
  } finally {
    await reap(child.pid, marker); // also on any error above
  }
}

describe('spawned test children are killed when the file ends (even after a failed assertion)', () => {
  it('the fixture fails mid-way, and its running child is gone afterwards (by the helper, before any reaping)', async () => {
    const { status, output, pid, marker, aliveBeforeReap, leftAfterReap } = await runFixture({}, 60_000);
    // The fixture's assertion failed (that is the scenario) ...
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/the assertion that fails mid-way/);
    expect(pid).toBeGreaterThan(0);
    // ... yet its child did not outlive the file: the helper's afterAll killed it.
    expect(aliveBeforeReap, `child ${pid} outlived the failed test file`).toBe(false);
    expect(leftAfterReap).toEqual([]);
    expect(pidsWithMarker(marker)).toEqual([]);
  }, 90_000);

  it('an INTERRUPTED nested run (killed before any afterAll) leaves nothing behind', async () => {
    const { signal, pid, marker, leftAfterReap } = await runFixture({ RATIO_ORPHAN_HANG: '1' }, 15_000);
    expect(signal).toBe('SIGKILL'); // the nested run was interrupted
    expect(pid, 'the fixture wrote its child pid before hanging').toBeGreaterThan(0);
    expect(leftAfterReap, 'reap() confirmed every process dead').toEqual([]);
    expect(alive(pid)).toBe(false);
    expect(pidsWithMarker(marker)).toEqual([]);
  }, 90_000);
});

describe('reap() returns only once every reaped process has actually exited (CI #54, run 37157034669)', () => {
  // SIGKILL is asynchronous: right after kill() returns, the target can still
  // show as running in /proc until the kernel schedules its exit (measured:
  // 'R' in 197/200 immediate checks idle, 99/200 under load). A check made
  // right after reaping must not race that.
  it('a detached group with an orphaned grandchild: dead (gone or zombie) as soon as reap() returns, 20 rounds', async () => {
    const script =
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),120000);setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
    const late: number[] = [];
    for (let i = 0; i < 20; i++) {
      const marker = crypto.randomBytes(8).toString('hex');
      const mid = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: { ...process.env, RATIO_ORPHAN_MARKER: marker } });
      const grandchild = await new Promise<number>((resolve) => mid.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))));
      const left = await reap(mid.pid, marker);
      if (alive(grandchild) || alive(mid.pid!)) late.push(grandchild);
      expect(left).toEqual([]);
    }
    expect(late, 'processes still running right after reap() returned').toEqual([]);
  }, 60_000);
});

