// Test-only helpers to drive the worker CLI in-process and as a real child
// process, and to load the committed synthetic fixture from disk.
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { afterAll } from 'vitest';
import { main } from '../cli';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const CLI_SOURCE = path.join(REPO_ROOT, 'src', 'ingest', 'cli.ts');
export const COMMITTED_FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'focus-1.0-synthetic');

export interface CliResult {
  code: number;
  out: string[];
  err: string[];
  /** The single evidence record printed on stdout (parsed), if exactly one line was printed. */
  record: { command: string; pass: boolean; exitCode: number; results: Record<string, unknown> } & Record<string, unknown>;
}

export async function cli(argv: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  let record = {} as CliResult['record'];
  if (out.length === 1) record = JSON.parse(out[0]);
  return { code, out, err, record };
}

/** Objects of a committed fixture variant, keyed exactly as they go into the bucket. */
export function committedObjects(variant: 'base' | 'restatement'): Array<{ key: string; bytes: Buffer }> {
  const dir = path.join(COMMITTED_FIXTURE_DIR, variant);
  const out: Array<{ key: string; bytes: Buffer }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ key: path.relative(dir, p).split(path.sep).join('/'), bytes: fs.readFileSync(p) });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface ControlTotals {
  [variant: string]: Record<string, { rowCount: number; billedTotal: string }>;
}

export function committedControlTotals(): ControlTotals {
  return JSON.parse(fs.readFileSync(path.join(COMMITTED_FIXTURE_DIR, 'control-totals.json'), 'utf8'));
}

export interface Spawned {
  child: ChildProcess;
  stderr: string[];
  stdout: string[];
  /** Resolves with the first stderr JSON line whose event matches. */
  waitForEvent(event: string): Promise<Record<string, unknown>>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Every child spawned through these helpers, until it exits. The afterAll
 * registered below (in every test file that imports this module) kills
 * whatever is still running — also when a test failed mid-way — so no test
 * child outlives its file (cli.spawnCleanup.test.ts proves it).
 */
const liveChildren = new Set<ChildProcess>();

/** Registers a child for the end-of-file cleanup; returns it. */
export function trackChild<T extends ChildProcess>(child: T): T {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

/** SIGKILLs every tracked child that is still running and waits for it to exit. */
export async function killTrackedChildren(): Promise<void> {
  await Promise.all(
    [...liveChildren].map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          c.once('exit', () => resolve());
          c.kill('SIGKILL');
        }),
    ),
  );
  liveChildren.clear();
}

afterAll(killTrackedChildren);

/** Spawns the worker CLI from source (tsx) as a real OS process (tracked: killed at the end of the file). */
export function spawnCli(argv: string[], env: Record<string, string>): Spawned {
  const child = trackChild(
    spawn(process.execPath, ['--import', 'tsx', CLI_SOURCE, ...argv], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const stderr: string[] = [];
  const stdout: string[] = [];
  const waiters: Array<{ event: string; resolve: (v: Record<string, unknown>) => void }> = [];
  let errBuf = '';
  child.stderr!.on('data', (d: Buffer) => {
    errBuf += d.toString('utf8');
    let i: number;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i);
      errBuf = errBuf.slice(i + 1);
      stderr.push(line);
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        for (const w of waiters.filter((x) => x.event === obj.event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(obj);
        }
      } catch {
        // non-JSON line (e.g. a crash trace) — kept in stderr for diagnostics
      }
    }
  });
  child.stdout!.on('data', (d: Buffer) => stdout.push(d.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    stderr,
    stdout,
    exited,
    waitForEvent(event: string) {
      const seen = stderr.map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      });
      const hit = seen.find((o) => o && o.event === event);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ event, resolve });
        void exited.then((x) => reject(new Error(`child exited (${JSON.stringify(x)}) before "${event}"; stderr:\n${stderr.join('\n')}`)));
      });
    },
  };
}
