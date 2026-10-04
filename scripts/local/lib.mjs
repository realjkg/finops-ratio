// Pure helpers for the LOCAL, EPHEMERAL Ratio stack (scripts/local/local.mjs).
// No Docker, no network, no database here: everything is unit-tested in
// scripts/local/local.test.mjs. Nothing in this file is a production setting.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

const { AbortController } = globalThis;

/**
 * Gitignored. Holds one directory PER COMPOSE PROJECT (`.ratio-local/<project>/env`),
 * so two stacks (a developer's and local:test's, or two checkouts' projects)
 * never share or wipe each other's secrets. `local:down -v` removes only its
 * own project's directory.
 */
export const LOCAL_STATE_DIR = '.ratio-local';

export function localStatePaths(project) {
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) throw new Error('invalid compose project name for the local state directory');
  const dir = `${LOCAL_STATE_DIR}/${project}`;
  return { dir, envFile: `${dir}/env` };
}

/** Removes `<root>/.ratio-local/<project>/`, then `.ratio-local/` itself if it is now empty. */
export function removeProjectState(root, project) {
  const { dir } = localStatePaths(project);
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  const parent = path.join(root, LOCAL_STATE_DIR);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
}

/** Writes the env file owner-only: directory 0700, file 0600 (also tightening an existing file). */
export function writeEnvFileSecure(file, env) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, serializeEnvFile(env), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Fixed local names (non-secret). */
export const LOCAL_NAMES = Object.freeze({
  database: 'ratio',
  migrator: 'ratio_local_migrator',
  worker: 'ratio_local_worker',
  reader: 'ratio_local_reader',
  sourceBucket: 'ratio-local-source',
  evidenceBucket: 'ratio-local-evidence',
  sourceKey: 'local-focus',
  tenantSlug: 'local-synthetic',
  /** The committed fixture is laid out under this prefix / export name (fixtures/focus-1.0-synthetic/base). */
  fixturePrefix: 'ratio-synthetic',
  fixtureExportName: 'focus-export',
});

const token = (bytes, random) => random(bytes).toString('base64url');

/** Fresh random local secrets (and the local tenant id). */
export function generateLocalSecrets(random = crypto.randomBytes) {
  let apiToken = token(36, random);
  // The repo's live-data rule needs >= 10 distinct characters; 48 random base64url chars virtually always have them.
  while (new Set(apiToken).size < 10) apiToken = token(36, random);
  return {
    RATIO_LOCAL_PG_SUPERUSER_PASSWORD: token(32, random),
    RATIO_LOCAL_MIGRATOR_PASSWORD: token(32, random),
    RATIO_LOCAL_WORKER_PASSWORD: token(32, random),
    RATIO_LOCAL_READER_PASSWORD: token(32, random),
    RATIO_LOCAL_S3_ACCESS_KEY_ID: `local${random(8).toString('hex')}`,
    RATIO_LOCAL_S3_SECRET_ACCESS_KEY: token(32, random),
    RATIO_LOCAL_API_TOKEN: apiToken,
    RATIO_LOCAL_TENANT_ID: crypto.randomUUID(),
  };
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const VALUE_RE = /^[A-Za-z0-9_.:@/+=-]*$/;

export function serializeEnvFile(env) {
  return (
    Object.keys(env)
      .sort()
      .map((k) => {
        if (!NAME_RE.test(k)) throw new Error('invalid variable name in the local env file');
        const v = String(env[k]);
        if (!VALUE_RE.test(v)) throw new Error(`invalid value for ${k} in the local env file`);
        return `${k}=${v}`;
      })
      .join('\n') + '\n'
  );
}

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error('malformed line in the local env file');
    out[m[1]] = m[2];
  }
  return out;
}

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function port(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) throw new Error(`${name} must be a port number 1024..65535`);
  const n = Number(raw);
  if (n < 1024 || n > 65535) throw new Error(`${name} must be a port number 1024..65535`);
  return n;
}

/** Ports and compose project name (all loopback). */
export function localSettings(env) {
  const project = env.RATIO_LOCAL_PROJECT ?? 'ratio-local';
  if (!PROJECT_RE.test(project)) throw new Error('RATIO_LOCAL_PROJECT must be lower-case letters, digits, - or _');
  return {
    project,
    pgPort: port(env, 'RATIO_LOCAL_PG_PORT', 54329),
    s3Port: port(env, 'RATIO_LOCAL_S3_PORT', 18343),
    appPort: port(env, 'RATIO_LOCAL_APP_PORT', 3100),
  };
}

/**
 * local:test's OWN project and ports (RATIO_LOCAL_TEST_*), never the
 * developer's RATIO_LOCAL_* stack: it brings its stack up and tears it down
 * with `down -v`, so it must not be able to point at a running dev stack.
 */
export function localTestSettings(env) {
  const project = env.RATIO_LOCAL_TEST_PROJECT ?? 'ratio-local-test';
  if (!PROJECT_RE.test(project)) throw new Error('RATIO_LOCAL_TEST_PROJECT must be lower-case letters, digits, - or _');
  const test = {
    project,
    pgPort: port(env, 'RATIO_LOCAL_TEST_PG_PORT', 54339),
    s3Port: port(env, 'RATIO_LOCAL_TEST_S3_PORT', 18353),
    appPort: port(env, 'RATIO_LOCAL_TEST_APP_PORT', 3110),
  };
  const dev = localSettings(env);
  if (test.project === dev.project) throw new Error(`local:test refuses the developer stack's project name (${dev.project})`);
  for (const p of [test.pgPort, test.s3Port, test.appPort]) {
    if ([dev.pgPort, dev.s3Port, dev.appPort].includes(p)) throw new Error(`local:test refuses port ${p}: the developer stack uses it`);
  }
  return test;
}

/** What makes local:test refuse to start (it would otherwise reuse or wipe something it did not create). */
export function preflightProblems({ stateExists, containers, busyPorts }) {
  const out = [];
  if (stateExists) out.push('local state for this project already exists (another stack or an interrupted run): run local:down -- -v for it first');
  if (containers > 0) out.push(`${containers} container(s) of this compose project already exist`);
  if (busyPorts.length) out.push(`port(s) already in use on 127.0.0.1: ${busyPorts.join(', ')}`);
  return out;
}

/**
 * Linux: true when the process `pid` (or a descendant) holds the LISTENING
 * TCP socket on `port` (from <procRoot>/net/tcp{,6} and <procRoot>/<pid>/fd);
 * false when another process does or nothing listens; null when /proc is not
 * available (the caller relies on its pre-start port check instead).
 */
export function ownsListeningSocket({ pid, port: p, procRoot = '/proc', maxProcesses = 4096 }) {
  const tables = ['tcp', 'tcp6'].map((t) => path.join(procRoot, 'net', t)).filter((f) => fs.existsSync(f));
  if (tables.length === 0) return null;
  const listening = new Set();
  for (const t of tables) {
    for (const line of fs.readFileSync(t, 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const local = f[1];
      const portHex = local.slice(local.lastIndexOf(':') + 1);
      if (f[3] === '0A' && parseInt(portHex, 16) === p) listening.add(f[9]);
    }
  }
  if (listening.size === 0) return false;
  const seen = new Set();
  const todo = [String(pid)];
  while (todo.length) {
    const cur = todo.pop();
    if (seen.has(cur)) continue;
    // Bounded work (this walk is synchronous, so a timer cannot bound it):
    // a tree larger than maxProcesses is not ours to vouch for, so refuse.
    if (seen.size >= maxProcesses) return false;
    seen.add(cur);
    const fdDir = path.join(procRoot, cur, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      fds = [];
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && listening.has(m[1])) return true;
    }
    let tasks;
    try {
      tasks = fs.readdirSync(path.join(procRoot, cur, 'task'));
    } catch {
      tasks = [];
    }
    for (const t of tasks) {
      try {
        todo.push(...fs.readFileSync(path.join(procRoot, cur, 'task', t, 'children'), 'utf8').split(/\s+/).filter(Boolean));
      } catch {
        // a task that ended meanwhile
      }
    }
  }
  return false;
}

/**
 * True when something accepts TCP connections on host:port (default
 * 127.0.0.1). Hard-bounded by timeoutMs: an attempt that has not settled by
 * then counts as busy (fail closed: local:test then refuses to start).
 */
export function portInUse(p, { host = '127.0.0.1', timeoutMs = 2_000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let s = null;
    const settle = (busy) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      s?.destroy();
      resolve(busy);
    };
    timer = setTimeout(() => settle(true), timeoutMs);
    s = connect({ host, port: p });
    s.setTimeout(timeoutMs);
    s.once('connect', () => settle(true));
    s.once('timeout', () => settle(true));
    s.once('error', () => settle(false));
  });
}

/**
 * Re-checks the port immediately before spawning (the preflight ran minutes
 * earlier, before the stack came up). On platforms without /proc this is what
 * keeps a foreign server from answering local:test's readiness probe.
 */
export async function startIfPortFree({ port: p, isBusy = portInUse, start }) {
  if (await isBusy(p)) throw new Error(`port ${p} became busy before next start could be spawned: refusing`);
  return start();
}

/**
 * Waits until the spawned server answers AND is the process we spawned:
 * fails fast if the child exits; when `owns` says another process holds the
 * listener (false) it refuses; when ownership cannot be determined (null, no
 * /proc) it relies on startIfPortFree's re-check. Returns 'pid-verified' or
 * 'port-preflight-only'.
 */
export async function waitForOwnServer({
  child,
  port: p,
  probe,
  owns = ownsListeningSocket,
  now = Date.now,
  sleep = defaultSleep,
  timeoutMs = 60_000,
  attemptTimeoutMs = 5_000,
  intervalMs = 500,
}) {
  requireDeadline(timeoutMs, 'waitForOwnServer timeoutMs');
  requireDeadline(attemptTimeoutMs, 'waitForOwnServer attemptTimeoutMs');
  const deadline = now() + timeoutMs;
  for (;;) {
    if (childExited(child)) {
      throw new Error(`next start exited (code ${child.exitCode}, signal ${child.signalCode}) before it was ready`);
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`timed out waiting for next start after ${timeoutMs} ms`);
    let ok;
    try {
      // Each attempt is aborted at its own deadline AND at the overall one:
      // a server that accepts TCP and never answers cannot hold the wait.
      ok = await withDeadline((signal) => probe(signal), Math.min(attemptTimeoutMs, remaining), 'next start readiness probe');
    } catch {
      ok = false;
    }
    if (ok) {
      const owned = owns({ pid: child.pid, port: p });
      if (owned === false) throw new Error(`a process other than the next start we spawned answers on port ${p}`);
      return owned === true ? 'pid-verified' : 'port-preflight-only';
    }
    const left = deadline - now();
    if (left > 0) await sleep(Math.min(intervalMs, left));
  }
}

// --- deadlines: every network call and wait in scripts/local is bounded -------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireDeadline(ms, what) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) throw new Error(`${what}: a positive deadline (ms) is required`);
}

/**
 * Runs fn(signal) under a HARD deadline: at `ms` the signal is aborted (so
 * fetch, the S3 SDK and our pg wrapper cancel their I/O) and the returned
 * promise rejects, even if fn ignores the signal and never settles.
 */
export function withDeadline(fn, ms, what) {
  try {
    requireDeadline(ms, `withDeadline(${what})`);
  } catch (e) {
    return Promise.reject(e);
  }
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} timed out after ${ms} ms`);
      err.code = 'RATIO_LOCAL_DEADLINE';
      ac.abort(err);
      reject(err);
    }, ms);
  });
  const work = Promise.resolve().then(() => fn(ac.signal));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Polls probe(signal) until it returns true. Each attempt is bounded by
 * attemptTimeoutMs AND by what is left of timeoutMs; the overall deadline is
 * checked before every attempt and caps every sleep, so the wait ends by
 * timeoutMs (plus at most one timer tick) whatever the probe does.
 */
export async function waitUntil({ what, probe, timeoutMs, attemptTimeoutMs, intervalMs = 1_000, now = Date.now, sleep = defaultSleep }) {
  requireDeadline(timeoutMs, `waitUntil(${what}) timeoutMs`);
  requireDeadline(attemptTimeoutMs, `waitUntil(${what}) attemptTimeoutMs`);
  const deadline = now() + timeoutMs;
  let last;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${what} after ${timeoutMs} ms${last ? `: ${last.message}` : ''}`);
    try {
      if (await withDeadline((signal) => probe(signal), Math.min(attemptTimeoutMs, remaining), `${what} (one attempt)`)) return;
    } catch (e) {
      last = e;
    }
    const left = deadline - now();
    if (left > 0) await sleep(Math.min(intervalMs, left));
  }
}

/**
 * GET url as JSON under a hard deadline covering the headers AND the body
 * (a body that stalls is a timeout, not a silently null body). Non-JSON
 * bodies give body: null. Returns { status, body }.
 */
export function fetchJson(url, { token, timeoutMs, fetchFn = globalThis.fetch } = {}) {
  const pathname = new URL(url).pathname;
  return withDeadline(
    async (signal) => {
      const r = await fetchFn(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
      const text = await r.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: r.status, body };
    },
    timeoutMs,
    `GET ${pathname}`,
  );
}

// --- child processes: every wait is bounded ------------------------------------

/**
 * A child has exited when it has an exit code OR was ended by a signal.
 * (A signalled child has exitCode === null: checking exitCode alone would
 * wait for an 'exit' event that has already fired, forever.)
 */
export function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child has exited (immediately if it already has), false after timeoutMs. */
function waitForExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // Listen first: if that throws, no timer is left behind.
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(childExited(child));
    }, timeoutMs);
  });
}

/**
 * Stops a child, never hanging: 'already-exited' (nothing sent), 'stopped'
 * (exited within graceMs of SIGTERM), 'killed' (needed SIGKILL), or
 * 'unresponsive' (still there killMs after SIGKILL: given up on, so the
 * caller's cleanup can go on).
 */
export async function stopChild(child, { graceMs = 10_000, killMs = 5_000 } = {}) {
  // A tracked group leader (next start, runProcess commands) is stopped as its
  // whole PROCESS GROUP, and counts as gone only when the group is empty
  // (Copilot 4176705245): a descendant that survives the leader's TERM gets
  // the KILL, and the result is never 'stopped' while it lives.
  const group = GROUP_LEADERS.has(child);
  const gone = () => childExited(child) && (!group || !groupAlive(child.pid));
  if (gone()) return 'already-exited';
  signalChild(child, 'SIGTERM');
  if (await waitUntilGone(child, gone, graceMs)) return 'stopped';
  signalChild(child, 'SIGKILL');
  if (await waitUntilGone(child, gone, killMs)) return 'killed';
  return 'unresponsive';
}

/** Waits (bounded) for the child to exit and, for a group, the group to empty. */
async function waitUntilGone(child, gone, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  if (!(await waitForExit(child, timeoutMs))) return false;
  while (!gone()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * local:test's cleanup: stop the app (bounded; errors recorded, not thrown),
 * then ALWAYS run `down` exactly once, itself cut off at downTimeoutMs (the
 * compose command under it has its own, shorter, timeout). Returns what
 * happened, never throws.
 */
export async function cleanupLocalTest({ app, down, stopOptions, downTimeoutMs = 330_000 }) {
  let appResult = null;
  if (app) {
    try {
      appResult = await stopChild(app, stopOptions);
    } catch (e) {
      appResult = `error: ${e?.message ?? e}`;
    }
  }
  let downResult;
  try {
    await withDeadline(() => down(), downTimeoutMs, 'down -v');
    downResult = 'ok';
  } catch (e) {
    downResult = `error: ${e?.message ?? e}`;
  }
  return { app: appResult, down: downResult };
}

/** App stop results that mean "we stopped the app we were still serving from". */
const APP_STOP_PASS = new Set(['stopped', 'killed']);

/**
 * THE pass/fail decision of a local:test run (pure). It passes only when the
 * body completed (no error), the app was still running and we stopped it
 * ('stopped' or 'killed'), and `down -v` succeeded. Everything else fails,
 * including app results this code does not know (fail closed). Every result
 * is recorded either way.
 */
export function finalizeLocalTestSummary({ project, steps, error, cleanup }) {
  const failures = [];
  if (error !== null && error !== undefined) failures.push(String(error));
  if (!APP_STOP_PASS.has(cleanup.app)) {
    failures.push(
      cleanup.app === null
        ? 'next start was never started'
        : cleanup.app === 'already-exited'
          ? 'next start had already exited before cleanup (it should still have been serving)'
          : `next start could not be stopped cleanly: ${cleanup.app}`,
    );
  }
  if (cleanup.down !== 'ok') failures.push(`down -v failed: ${cleanup.down}`);
  const summary = {
    project,
    steps: { ...steps, appStop: cleanup.app, down: cleanup.down === 'ok' ? 'ok (-v)' : cleanup.down },
    pass: failures.length === 0,
    failures,
  };
  if (error !== null && error !== undefined) summary.error = String(error);
  return summary;
}

/**
 * Runs local:test's body, then ALWAYS the bounded cleanup, then decides
 * pass/fail with finalizeLocalTestSummary. The body reports the spawned app
 * through setApp(child) as soon as it exists, so cleanup can stop it.
 */
export async function runLocalTest({ project, body, down, stopOptions, downTimeoutMs, signal, bodySettleMs = 10_000 }) {
  const steps = {};
  let app = null;
  let error = null;
  // Once the cleanup has started (body done, or interrupted), nothing may be
  // spawned and nothing may become `app` (Copilot 4176494798): spawnGuard
  // refuses, and a child handed to setApp late is killed and awaited.
  let closing = false;
  const lateKills = [];
  const killLate = (child) => {
    killGroup(child, 'SIGKILL');
    lateKills.push(waitForExit(child, 5_000));
  };
  const setApp = (child) => {
    if (closing) {
      killLate(child);
      throw new Error('local:test cleanup has started: a late child was killed');
    }
    app = child;
  };
  const spawnGuard = (fn) => (...args) => {
    if (closing) throw new Error('local:test cleanup has started: refusing to spawn');
    return fn(...args);
  };
  // An interrupt (SIGINT/SIGTERM in local.mjs aborts `signal` with the signal
  // name) ends the body at once, whatever it is awaiting, and goes through the
  // SAME bounded cleanup; its commands, bound to the signal, are killed. A
  // signal during the cleanup is recorded (exit code) but runs nothing twice.
  let interrupted = null;
  let onAbort = () => undefined;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      interrupted = String(signal.reason ?? 'interrupt');
      closing = true;
      reject(new Error(`interrupted by ${interrupted}`));
    };
  });
  aborted.catch(() => undefined);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const running = Promise.resolve().then(() => body({ steps, signal, setApp, spawnGuard }));
  running.catch(() => undefined);
  try {
    await Promise.race([running, aborted]);
  } catch (e) {
    error = e?.message ?? String(e);
  }
  closing = true;
  const cleanup = await cleanupLocalTest({ app, down, stopOptions, downTimeoutMs });
  signal?.removeEventListener('abort', onAbort);
  // Let an interrupted body settle (bounded) so that any late child it hands
  // over is killed before the caller's final process-group sweep.
  await withDeadline(() => running.catch(() => undefined), bodySettleMs, 'interrupted body settling').catch(() => undefined);
  await Promise.all(lateKills);
  const summary = finalizeLocalTestSummary({ project, steps, error, cleanup });
  if (lateKills.length) summary.lateChildren = lateKills.length;
  if (interrupted) {
    summary.interrupted = interrupted;
    if (summary.pass) {
      summary.pass = false;
      summary.failures.push(`interrupted by ${interrupted} during the cleanup`);
    }
  }
  return summary;
}

/** 130 for SIGINT, 143 for SIGTERM (128 + the signal number), as a shell reports them. */
export function exitCodeForSignal(signal) {
  return signal === 'SIGTERM' ? 143 : 130;
}

/** local:test's exit code: an interrupt wins (130/143), else 0 only when the run passed. */
export function localTestExitCode(summary) {
  if (summary.interrupted) return exitCodeForSignal(summary.interrupted);
  return summary.pass === true ? 0 : 1;
}

/**
 * SIGINT/SIGTERM handling for local.mjs (proc is injectable for tests): the
 * FIRST signal calls onFirst(signal); any later one calls onForce(signal).
 * Returns a function that removes the listeners.
 */
export function installInterruptHandlers({ proc = process, onFirst, onForce }) {
  let count = 0;
  const handler = (sig) => {
    count += 1;
    if (count === 1) onFirst(sig);
    else onForce(sig);
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const sig of signals) proc.on(sig, handler);
  return () => {
    for (const sig of signals) proc.removeListener(sig, handler);
  };
}

/** Process groups of runProcess children still running (pgid = child pid). */
const LIVE_GROUPS = new Set();
/** Children that lead their own process group (spawned detached by runProcess or tracked). */
const GROUP_LEADERS = new WeakSet();

/**
 * True while process group `pgid` has a live (non-zombie) member. Linux:
 * kill(-pgid, 0) fails with ESRCH once the group is empty; zombies still
 * count for kill(), so /proc confirms (a container's PID 1 may not reap
 * orphans). Never true for pgid <= 1.
 */
export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    return e?.code === 'EPERM';
  }
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return true; // no /proc: kill(-pgid, 0) succeeded
  }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) === pgid && f[0] !== 'Z') return true;
    } catch {
      // ended meanwhile
    }
  }
  return false;
}

/**
 * Signals a tracked leader's whole group; any other child alone. Only ESRCH
 * (the group is already empty) falls back to the child itself; any other
 * failure propagates, as child.kill's does (the caller records it).
 */
function signalChild(child, signal) {
  if (GROUP_LEADERS.has(child) && Number.isInteger(child.pid) && child.pid > 1) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (e) {
      if (e?.code !== 'ESRCH') throw e;
    }
  }
  child.kill(signal);
}

/** Drops `pgid` from the live set only once its group is empty (not when the leader exits). */
function pruneGroup(pgid) {
  if (!groupAlive(pgid)) LIVE_GROUPS.delete(pgid);
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Tracks a child spawned outside runProcess (next start) in the same set, so
 * killLiveProcessGroups reaches it too. Spawn it `detached: true` (its own
 * group). It leaves the set when it exits. Returns the child.
 */
export function trackProcessGroup(child) {
  if (child?.pid) {
    GROUP_LEADERS.add(child);
    LIVE_GROUPS.add(child.pid);
    child.once('exit', () => pruneGroup(child.pid));
  }
  return child;
}

/** The pids (= process group ids) currently tracked. */
export function liveProcessGroups() {
  for (const pid of [...LIVE_GROUPS]) pruneGroup(pid);
  return [...LIVE_GROUPS];
}

/**
 * SIGKILLs every tracked process group (runProcess commands and next start).
 * local.mjs calls it on a forced exit (second signal) and when interrupting a
 * command other than local:test: the groups are detached, so a Ctrl-C to
 * local.mjs would otherwise not reach them.
 */
export function killLiveProcessGroups() {
  for (const pid of [...LIVE_GROUPS]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
    pruneGroup(pid);
  }
}

/**
 * Runs a command under a REQUIRED, HARD deadline, whatever the stdio mode.
 * - The command runs in its own process group (detached), so a timeout
 *   SIGKILLs it AND its descendants.
 * - At timeoutMs the promise rejects ("timed out") at once: it does not wait
 *   for 'close', which never fires while a grandchild still holds a stdio pipe.
 * - When the command exits but a descendant keeps the pipe open, the result
 *   is settled exitGraceMs after 'exit' (the group is then killed and the
 *   pipe destroyed), still within the deadline.
 */
export function runProcess(cmd, args, { cwd, env, capture = false, captureErr = false, allowFail = false, timeoutMs, exitGraceMs = 2_000, spawnFn = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    requireDeadline(timeoutMs, `runProcess(${cmd} ${args[0] ?? ''}) timeoutMs`);
    const label = `${cmd} ${args[0] ?? ''}`;
    // Bound to an interrupt signal: never started once it fired; killed when it fires.
    if (signal?.aborted) {
      reject(new Error(`${label} not started: interrupted by ${signal.reason ?? 'interrupt'}`));
      return;
    }
    // captureErr: stderr is piped, kept, and still passed through to this process's stderr.
    const child = spawnFn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', captureErr ? 'pipe' : 'inherit'] });
    if (child.pid) {
      GROUP_LEADERS.add(child);
      LIVE_GROUPS.add(child.pid);
    }
    let out = '';
    let err = '';
    let settled = false;
    let graceTimer = null;
    const onAbort = () => {
      killGroup(child, 'SIGKILL');
      finish(() => reject(new Error(`${label} interrupted by ${signal.reason ?? 'interrupt'} (killed)`)));
    };
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      pruneGroup(child.pid);
      settle();
    };
    const byExit = (code, signal) => () => {
      if (code !== 0 && !allowFail) reject(new Error(`${label} exited ${code ?? `by ${signal}`}`));
      else resolve(captureErr ? { code, out, err } : { code, out });
    };
    const deadline = setTimeout(() => {
      killGroup(child, 'SIGKILL');
      finish(() => reject(new Error(`${label} timed out after ${timeoutMs} ms (killed)`)));
    }, timeoutMs);
    if (capture) child.stdout.on('data', (d) => (out += d));
    if (captureErr) {
      child.stderr.on('data', (d) => {
        err += d;
        process.stderr.write(d);
      });
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code, signal) => {
      graceTimer = setTimeout(() => {
        // A descendant still holds the pipe: end it and settle on the exit status.
        killGroup(child, 'SIGKILL');
        finish(byExit(code, signal));
      }, exitGraceMs);
    });
    child.on('close', (code, signal) => finish(byExit(code, signal)));
  });
}

export function connectionUrl({ user, password, port: p, database }) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${p}/${encodeURIComponent(database)}`;
}

/** Env for every worker CLI command against the local stack (source and evidence on the local SeaweedFS). */
/**
 * Env for the worker CLI. `syntheticProviders: true` sets the synthetic-provider
 * opt-in (issue #62 D1), for the SYNTHETIC fixture source only. Otherwise it is
 * set to '0' EXPLICITLY, so an opt-in exported in the operator's shell never
 * leaks into the worker (run() lays this env over process.env; challenger L2).
 */
export function workerEnv(settings, secrets, { syntheticProviders = false } = {}) {
  const s3 = `http://127.0.0.1:${settings.s3Port}`;
  return {
    RATIO_ALLOW_SYNTHETIC_PROVIDERS: syntheticProviders === true ? '1' : '0',
    RATIO_ENV: 'development',
    RATIO_DATABASE_URL: connectionUrl({ user: LOCAL_NAMES.worker, password: secrets.RATIO_LOCAL_WORKER_PASSWORD, port: settings.pgPort, database: LOCAL_NAMES.database }),
    RATIO_MIGRATE_DATABASE_URL: connectionUrl({ user: LOCAL_NAMES.migrator, password: secrets.RATIO_LOCAL_MIGRATOR_PASSWORD, port: settings.pgPort, database: LOCAL_NAMES.database }),
    RATIO_SOURCE_S3_ENDPOINT: s3,
    RATIO_SOURCE_S3_REGION: 'us-east-1',
    RATIO_SOURCE_S3_ACCESS_KEY_ID: secrets.RATIO_LOCAL_S3_ACCESS_KEY_ID,
    RATIO_SOURCE_S3_SECRET_ACCESS_KEY: secrets.RATIO_LOCAL_S3_SECRET_ACCESS_KEY,
    RATIO_SOURCE_S3_FORCE_PATH_STYLE: '1',
    RATIO_EVIDENCE_S3_ENDPOINT: s3,
    RATIO_EVIDENCE_S3_REGION: 'us-east-1',
    RATIO_EVIDENCE_S3_BUCKET: LOCAL_NAMES.evidenceBucket,
    RATIO_EVIDENCE_S3_ACCESS_KEY_ID: secrets.RATIO_LOCAL_S3_ACCESS_KEY_ID,
    RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY: secrets.RATIO_LOCAL_S3_SECRET_ACCESS_KEY,
  };
}

/** Env for the Next.js app serving GET /api/v1/costs/published locally. */
export function apiEnv(settings, secrets) {
  return {
    RATIO_API_TOKEN: secrets.RATIO_LOCAL_API_TOKEN,
    RATIO_API_TENANT_ID: secrets.RATIO_LOCAL_TENANT_ID,
    RATIO_READER_DATABASE_URL: connectionUrl({ user: LOCAL_NAMES.reader, password: secrets.RATIO_LOCAL_READER_PASSWORD, port: settings.pgPort, database: LOCAL_NAMES.database }),
  };
}

/**
 * Compares the API's first-page totals with the fixture's control totals
 * ({ 'YYYY-MM-01': { rowCount, billedTotal } }). EXACT decimal strings: a
 * different scale is a mismatch too. Returns the list of mismatches.
 */
export function compareControlTotals(totals, control) {
  const problems = [];
  const seen = new Set();
  for (const t of totals) {
    const key = t.billingPeriod;
    if (seen.has(key)) {
      problems.push(`${key}: more than one totals entry (currency ${t.billingCurrency})`);
      continue;
    }
    seen.add(key);
    const c = control[key];
    if (!c) {
      problems.push(`${key}: not in the control totals`);
      continue;
    }
    // The API's rowCount is a bigint count as a decimal string (Copilot 4176238961):
    // strict !== against the control's text form, so a JS number never matches.
    if (t.rowCount !== String(c.rowCount)) problems.push(`${key}: rowCount ${JSON.stringify(t.rowCount)} != control "${c.rowCount}"`);
    if (t.billedCost !== c.billedTotal) problems.push(`${key}: billedCost ${t.billedCost} != control ${c.billedTotal}`);
  }
  for (const key of Object.keys(control)) if (!seen.has(key)) problems.push(`${key}: missing from the API totals`);
  return problems;
}
