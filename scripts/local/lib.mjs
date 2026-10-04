// Pure helpers for the LOCAL, EPHEMERAL Ratio stack (scripts/local/local.mjs).
// No Docker, no network, no database here: everything is unit-tested in
// scripts/local/local.test.mjs. Nothing in this file is a production setting.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout } from 'node:timers';

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
export function ownsListeningSocket({ pid, port: p, procRoot = '/proc' }) {
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

/** True when something accepts TCP connections on host:port (default 127.0.0.1). */
export function portInUse(p, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: p });
    s.setTimeout(1000);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('timeout', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
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
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 60_000,
  intervalMs = 500,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`next start exited (code ${child.exitCode}, signal ${child.signalCode}) before it was ready`);
    }
    let ok;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) {
      const owned = owns({ pid: child.pid, port: p });
      if (owned === false) throw new Error(`a process other than the next start we spawned answers on port ${p}`);
      return owned === true ? 'pid-verified' : 'port-preflight-only';
    }
    if (now() > deadline) throw new Error('timed out waiting for next start');
    await sleep(intervalMs);
  }
}

export function connectionUrl({ user, password, port: p, database }) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${p}/${encodeURIComponent(database)}`;
}

/** Env for every worker CLI command against the local stack (source and evidence on the local SeaweedFS). */
export function workerEnv(settings, secrets) {
  const s3 = `http://127.0.0.1:${settings.s3Port}`;
  return {
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
    if (t.rowCount !== c.rowCount) problems.push(`${key}: rowCount ${t.rowCount} != control ${c.rowCount}`);
    if (t.billedCost !== c.billedTotal) problems.push(`${key}: billedCost ${t.billedCost} != control ${c.billedTotal}`);
  }
  for (const key of Object.keys(control)) if (!seen.has(key)) problems.push(`${key}: missing from the API totals`);
  return problems;
}
