// Static/pure tests of the local stack tooling (no Docker, no database):
// generated local secrets, the env state file, settings validation, the role
// bootstrap plan (no dangerous attribute or membership), the compose file
// (loopback-only ports, digest-pinned images, no trust auth), .env.example
// (names only) and the control-total comparison used by `local:test`.
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  LOCAL_NAMES,
  LOCAL_STATE_DIR,
  compareControlTotals,
  connectionUrl,
  generateLocalSecrets,
  localSettings,
  localStatePaths,
  localTestSettings,
  ownsListeningSocket,
  parseEnvFile,
  cleanupLocalTest,
  childExited,
  exitCodeForSignal,
  installInterruptHandlers,
  killLiveProcessGroups,
  liveProcessGroups,
  localTestExitCode,
  trackProcessGroup,
  fetchJson,
  finalizeLocalTestSummary,
  runLocalTest,
  waitUntil,
  withDeadline,
  portInUse,
  preflightProblems,
  removeProjectState,
  runProcess,
  serializeEnvFile,
  startIfPortFree,
  stopChild,
  waitForOwnServer,
  writeEnvFileSecure,
} from './lib.mjs';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { bootstrapPlan } from './bootstrap.mjs';

const { AbortController } = globalThis;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('L1 generated local secrets', () => {
  it('are random, distinct, strong, and the tenant id is a canonical uuid', () => {
    const a = generateLocalSecrets();
    const b = generateLocalSecrets();
    const keys = Object.keys(a).sort();
    expect(keys).toEqual(
      [
        'RATIO_LOCAL_API_TOKEN',
        'RATIO_LOCAL_MIGRATOR_PASSWORD',
        'RATIO_LOCAL_PG_SUPERUSER_PASSWORD',
        'RATIO_LOCAL_READER_PASSWORD',
        'RATIO_LOCAL_S3_ACCESS_KEY_ID',
        'RATIO_LOCAL_S3_SECRET_ACCESS_KEY',
        'RATIO_LOCAL_TENANT_ID',
        'RATIO_LOCAL_WORKER_PASSWORD',
      ].sort(),
    );
    for (const k of keys) expect(a[k], k).not.toBe(b[k]);
    const values = keys.map((k) => a[k]);
    expect(new Set(values).size).toBe(values.length);
    expect(a.RATIO_LOCAL_TENANT_ID).toMatch(UUID_V4);
    // The API token passes the repo's live-data strength rule (>= 32 chars, >= 10 distinct).
    expect(a.RATIO_LOCAL_API_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(new Set(a.RATIO_LOCAL_API_TOKEN).size).toBeGreaterThanOrEqual(10);
    for (const k of keys.filter((k) => k.endsWith('PASSWORD') || k.endsWith('SECRET_ACCESS_KEY'))) {
      expect(a[k], k).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    }
  });
});

describe('L2 env state file', () => {
  it('round-trips, sorted, one NAME=value per line', () => {
    const env = { B_KEY: 'two', A_KEY: 'one-1_x' };
    const text = serializeEnvFile(env);
    expect(text).toBe('A_KEY=one-1_x\nB_KEY=two\n');
    expect(parseEnvFile(text)).toEqual(env);
    expect(parseEnvFile('# comment\n\nX=1\n')).toEqual({ X: '1' });
  });

  it('refuses values or names that would break the file', () => {
    expect(() => serializeEnvFile({ X: 'a\nB=evil' })).toThrow();
    expect(() => serializeEnvFile({ 'bad name': 'x' })).toThrow();
    expect(() => parseEnvFile('not an assignment\n')).toThrow();
  });

  it('the state directory is gitignored', () => {
    expect(LOCAL_STATE_DIR).toBe('.ratio-local');
    expect(read('.gitignore').split('\n')).toContain('.ratio-local/');
  });
});

describe('L3 settings', () => {
  it('defaults and overrides', () => {
    expect(localSettings({})).toEqual({ project: 'ratio-local', pgPort: 54329, s3Port: 18343, appPort: 3100 });
    expect(localSettings({ RATIO_LOCAL_PROJECT: 'ratio-local-x1', RATIO_LOCAL_PG_PORT: '55710', RATIO_LOCAL_S3_PORT: '18710', RATIO_LOCAL_APP_PORT: '3710' })).toEqual({
      project: 'ratio-local-x1',
      pgPort: 55710,
      s3Port: 18710,
      appPort: 3710,
    });
  });

  it('refuses bad ports and project names', () => {
    for (const v of ['0', '80', '65536', 'abc', '5432x', '-1', '']) expect(() => localSettings({ RATIO_LOCAL_PG_PORT: v }), v).toThrow();
    for (const v of ['Ratio', 'a b', '../x', '-x', '']) expect(() => localSettings({ RATIO_LOCAL_PROJECT: v }), v).toThrow();
  });

  it('connection URLs encode credentials and always target loopback', () => {
    const url = connectionUrl({ user: 'ratio_local_reader', password: 'p@ss/w:rd', port: 54329, database: 'ratio' });
    expect(url).toBe('postgres://ratio_local_reader:p%40ss%2Fw%3Ard@127.0.0.1:54329/ratio');
    expect(new URL(url).hostname).toBe('127.0.0.1');
  });
});

describe('L4 role bootstrap plan (Slice 0 privilege model: no dangerous attribute or membership)', () => {
  const plan = bootstrapPlan(LOCAL_NAMES);
  const text = plan.join('\n');
  const roleDdl = plan.filter((s) => /\b(CREATE|ALTER) ROLE\b/i.test(s));

  it('names are the documented local logins', () => {
    expect(LOCAL_NAMES).toMatchObject({
      database: 'ratio',
      migrator: 'ratio_local_migrator',
      worker: 'ratio_local_worker',
      reader: 'ratio_local_reader',
    });
  });

  it('never grants a dangerous attribute (only the NO... forms appear)', () => {
    expect(roleDdl.length).toBeGreaterThanOrEqual(6);
    for (const s of roleDdl) {
      expect(s, s).not.toMatch(/(?<!NO)\b(SUPERUSER|BYPASSRLS|REPLICATION|CREATEROLE|CREATEDB)\b/);
      for (const attr of ['NOSUPERUSER', 'NOBYPASSRLS', 'NOREPLICATION', 'NOCREATEROLE', 'NOCREATEDB']) expect(s, s).toContain(attr);
    }
  });

  it('the three ratio roles are NOLOGIN and members of nothing; each login is a member of exactly its one ratio role', () => {
    for (const r of ['ratio_owner', 'ratio_worker', 'ratio_reader']) {
      const s = roleDdl.find((x) => new RegExp(`CREATE ROLE ${r} `).test(x));
      expect(s, r).toBeDefined();
      expect(s).toContain('NOLOGIN');
      expect(s).not.toMatch(/IN ROLE|ROLE \w+ ADMIN/);
    }
    const memberships = [...text.matchAll(/IN ROLE (\w+)/g)].map((m) => m[1]).sort();
    expect(memberships).toEqual(['ratio_owner', 'ratio_reader', 'ratio_worker']);
    expect(text).toMatch(/CREATE ROLE ratio_local_migrator LOGIN [^\n]*IN ROLE ratio_owner/);
    expect(text).toMatch(/CREATE ROLE ratio_local_worker LOGIN [^\n]*IN ROLE ratio_worker/);
    expect(text).toMatch(/CREATE ROLE ratio_local_reader LOGIN [^\n]*IN ROLE ratio_reader/);
    expect(text).not.toMatch(/\bGRANT\b/);
  });

  it('the migrator owns the database; nothing is granted on the database or any object', () => {
    expect(text).toMatch(/CREATE DATABASE ratio OWNER ratio_local_migrator/);
    expect(text).not.toMatch(/ON DATABASE/);
  });

  it('every step is guarded so the bootstrap is idempotent, and no password is part of the plan', () => {
    for (const s of plan.filter((x) => /\bCREATE (ROLE|DATABASE)\b/.test(x))) expect(s, s).toMatch(/NOT EXISTS/);
    expect(text).not.toMatch(/PASSWORD\s+'/i);
  });

  it('refuses identifiers that are not plain lower-case names', () => {
    expect(() => bootstrapPlan({ ...LOCAL_NAMES, reader: 'x; DROP ROLE ratio_owner' })).toThrow();
    expect(() => bootstrapPlan({ ...LOCAL_NAMES, database: 'Ratio' })).toThrow();
  });
});

describe('L5 docker-compose.local.yml', () => {
  const compose = read('docker-compose.local.yml');

  it('publishes every port on 127.0.0.1 only', () => {
    const ports = [...compose.matchAll(/^\s+-\s*"?([^"\n]+:\d+)"?\s*$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p) && !p.includes('/'));
    expect(ports.length).toBeGreaterThanOrEqual(2);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
  });

  it('pins Postgres 16 and SeaweedFS by digest (SeaweedFS: the digest CI uses)', () => {
    const images = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);
    expect(images).toContain('postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54');
    const ci = read('.github/workflows/ci.yml');
    const seaweed = ci.match(/chrislusf\/seaweedfs@sha256:[0-9a-f]{64}/)?.[0];
    expect(seaweed).toBeTruthy();
    expect(images).toContain(seaweed);
    for (const img of images) expect(img, img).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('requires a superuser password from the environment and never uses trust auth', () => {
    expect(compose).toMatch(/POSTGRES_PASSWORD:\s*"?\$\{RATIO_LOCAL_PG_SUPERUSER_PASSWORD:\?/);
    expect(compose).not.toMatch(/trust/i);
  });

  it('the app and worker services are optional profiles; the worker is a one-shot job', () => {
    expect(compose).toMatch(/^\s{2}app:\n(?:\s{4}.*\n)*?\s{4}profiles:\s*\["app"\]/m);
    expect(compose).toMatch(/^\s{2}worker:\n(?:\s{4}.*\n)*?\s{4}profiles:\s*\["worker"\]/m);
    expect(compose).toMatch(/^\s{2}worker:\n(?:\s{4}.*\n)*?\s{4}restart:\s*"no"/m);
  });
});

describe('L6 .env.example lists the new variables by name only', () => {
  const example = read('.env.example');
  const NEW_NAMES = [
    'RATIO_API_TENANT_ID',
    'RATIO_READER_DATABASE_URL',
    'RATIO_DATABASE_URL',
    'RATIO_MIGRATE_DATABASE_URL',
    'RATIO_ENV',
    'RATIO_SOURCE_S3_ENDPOINT',
    'RATIO_SOURCE_S3_REGION',
    'RATIO_SOURCE_S3_ACCESS_KEY_ID',
    'RATIO_SOURCE_S3_SECRET_ACCESS_KEY',
    'RATIO_SOURCE_S3_FORCE_PATH_STYLE',
    'RATIO_EVIDENCE_S3_ENDPOINT',
    'RATIO_EVIDENCE_S3_REGION',
    'RATIO_EVIDENCE_S3_BUCKET',
    'RATIO_EVIDENCE_S3_PREFIX',
    'RATIO_EVIDENCE_S3_ACCESS_KEY_ID',
    'RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY',
    'RATIO_LOCAL_PROJECT',
    'RATIO_LOCAL_PG_PORT',
    'RATIO_LOCAL_S3_PORT',
    'RATIO_LOCAL_APP_PORT',
  ];

  it('every new name is present with an empty value', () => {
    for (const name of NEW_NAMES) expect(example, name).toMatch(new RegExp(`^${name}=$`, 'm'));
  });

  it('no RATIO_* assignment in the file carries a value', () => {
    const assigned = [...example.matchAll(/^(RATIO_[A-Z0-9_]+)=(.*)$/gm)];
    for (const [, name, value] of assigned) expect(value, name).toBe('');
  });
});

describe('L7 npm scripts', () => {
  it('local:* and check:bundle are wired to the committed scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const cmd of ['up', 'migrate', 'seed', 'sync', 'down', 'test']) {
      expect(scripts[`local:${cmd}`], cmd).toBe(`node scripts/local/local.mjs ${cmd}`);
    }
    expect(scripts['check:bundle']).toBe('node scripts/check-next-bundle.mjs');
  });
});

describe('L8 control totals comparison (local:test acceptance)', () => {
  const control = { '2026-07-01': { rowCount: 55, billedTotal: '30.8272954899' }, '2026-08-01': { rowCount: 40, billedTotal: '21.0978157665' } };
  const totals = [
    { billingPeriod: '2026-07-01', billingCurrency: 'USD', rowCount: '55', billedCost: '30.8272954899' },
    { billingPeriod: '2026-08-01', billingCurrency: 'USD', rowCount: '40', billedCost: '21.0978157665' },
  ];

  it('equal totals ⇒ no mismatch', () => {
    expect(compareControlTotals(totals, control)).toEqual([]);
  });

  it('exact strings: a different scale, a different value, a count, a missing or an extra period all mismatch', () => {
    const mut = (i, patch) => totals.map((t, j) => (j === i ? { ...t, ...patch } : t));
    expect(compareControlTotals(mut(0, { billedCost: '30.82729548990' }), control)).toHaveLength(1);
    expect(compareControlTotals(mut(0, { billedCost: '30.8272954898' }), control)).toHaveLength(1);
    expect(compareControlTotals(mut(1, { rowCount: '39' }), control)).toHaveLength(1);
    // The API's rowCount is a decimal string (Copilot 4176238961): a JS number is a mismatch, even when equal in value.
    expect(compareControlTotals(mut(1, { rowCount: 40 }), control)).toHaveLength(1);
    expect(compareControlTotals(mut(1, { rowCount: '040' }), control)).toHaveLength(1);
    expect(compareControlTotals(totals.slice(1), control)).toHaveLength(1);
    expect(compareControlTotals([...totals, { billingPeriod: '2026-09-01', billingCurrency: 'USD', rowCount: '1', billedCost: '1' }], control)).toHaveLength(1);
    expect(compareControlTotals([...totals, { ...totals[0], billingCurrency: 'EUR' }], control)).not.toEqual([]);
  });

  it('the committed fixture control totals are the ones the CI step asserts', () => {
    const committed = JSON.parse(read('fixtures/focus-1.0-synthetic/control-totals.json')).base;
    expect(committed).toEqual(control);
  });
});

// --- challenger Lows (PR #59): per-project state, secure env file, isolated
// local:test, and a readiness probe that checks the server is the one we started.
const tmpDirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-local-test-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('L9 state is per compose project', () => {
  it('lives under .ratio-local/<project>/', () => {
    expect(localStatePaths('ratio-local')).toEqual({ dir: '.ratio-local/ratio-local', envFile: '.ratio-local/ratio-local/env' });
    expect(localStatePaths('ratio-local-test')).toEqual({ dir: '.ratio-local/ratio-local-test', envFile: '.ratio-local/ratio-local-test/env' });
    for (const bad of ['', '../x', 'a/b', 'Ratio', '.']) expect(() => localStatePaths(bad), bad).toThrow();
  });

  it('removing one project’s state leaves another project’s state alone; the parent goes when empty', () => {
    const root = tmp();
    for (const p of ['ratio-local', 'ratio-local-test']) {
      fs.mkdirSync(path.join(root, '.ratio-local', p), { recursive: true });
      fs.writeFileSync(path.join(root, '.ratio-local', p, 'env'), 'X=1\n');
    }
    removeProjectState(root, 'ratio-local-test');
    expect(fs.existsSync(path.join(root, '.ratio-local', 'ratio-local-test'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.ratio-local', 'ratio-local', 'env'), 'utf8')).toBe('X=1\n');
    removeProjectState(root, 'ratio-local');
    expect(fs.existsSync(path.join(root, '.ratio-local'))).toBe(false);
    expect(() => removeProjectState(root, '../evil')).toThrow();
  });
});

describe('L10 the env file is written owner-only (0600, directory 0700)', () => {
  it('creates and also tightens an existing file', () => {
    const root = tmp();
    const file = path.join(root, '.ratio-local', 'p1', 'env');
    writeEnvFileSecure(file, { A: 'one' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, 'utf8')).toBe('A=one\n');
    fs.chmodSync(file, 0o644);
    writeEnvFileSecure(file, { A: 'two' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('A=two\n');
  });
});

describe('L11 local:test is isolated from a developer stack', () => {
  it('has its own project and ports, and never reads the developer settings', () => {
    expect(localTestSettings({})).toEqual({ project: 'ratio-local-test', pgPort: 54339, s3Port: 18353, appPort: 3110 });
    // A developer's RATIO_LOCAL_* do not redirect local:test onto their stack.
    expect(localTestSettings({ RATIO_LOCAL_PROJECT: 'mine', RATIO_LOCAL_PG_PORT: '54320' })).toEqual({ project: 'ratio-local-test', pgPort: 54339, s3Port: 18353, appPort: 3110 });
    expect(localTestSettings({ RATIO_LOCAL_TEST_PROJECT: 'ci-e2e', RATIO_LOCAL_TEST_PG_PORT: '55710', RATIO_LOCAL_TEST_S3_PORT: '18710', RATIO_LOCAL_TEST_APP_PORT: '3710' })).toEqual({
      project: 'ci-e2e',
      pgPort: 55710,
      s3Port: 18710,
      appPort: 3710,
    });
  });

  it('refuses to share a project name or a port with the developer stack', () => {
    expect(() => localTestSettings({ RATIO_LOCAL_TEST_PROJECT: 'ratio-local' })).toThrow();
    expect(() => localTestSettings({ RATIO_LOCAL_PROJECT: 'mine', RATIO_LOCAL_TEST_PROJECT: 'mine' })).toThrow();
    expect(() => localTestSettings({ RATIO_LOCAL_TEST_PG_PORT: '54329' })).toThrow();
    expect(() => localTestSettings({ RATIO_LOCAL_APP_PORT: '3999', RATIO_LOCAL_TEST_APP_PORT: '3999' })).toThrow();
  });

  it('preflight refuses existing state, existing containers or a busy port', () => {
    expect(preflightProblems({ stateExists: false, containers: 0, busyPorts: [] })).toEqual([]);
    expect(preflightProblems({ stateExists: true, containers: 0, busyPorts: [] })).toHaveLength(1);
    expect(preflightProblems({ stateExists: false, containers: 2, busyPorts: [] })).toHaveLength(1);
    expect(preflightProblems({ stateExists: false, containers: 0, busyPorts: [3110] }).join(' ')).toContain('3110');
  });
});

describe('L12 readiness: the responding server must be the one local:test started', () => {
  /** A synthetic /proc: net/tcp(6) listeners, fd symlinks per pid, children lists. */
  function proc({ tcp = [], tcp6 = [], fds = {}, children = {} }) {
    const root = tmp();
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const line = (i, addr, st, inode) => `   ${i}: ${addr} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
    fs.mkdirSync(path.join(root, 'net'), { recursive: true });
    fs.writeFileSync(path.join(root, 'net', 'tcp'), head + tcp.map(([a, st, ino], i) => line(i, a, st, ino)).join(''));
    if (tcp6.length) fs.writeFileSync(path.join(root, 'net', 'tcp6'), head + tcp6.map(([a, st, ino], i) => line(i, a, st, ino)).join(''));
    for (const [pid, inodes] of Object.entries(fds)) {
      fs.mkdirSync(path.join(root, pid, 'fd'), { recursive: true });
      inodes.forEach((ino, i) => fs.symlinkSync(`socket:[${ino}]`, path.join(root, pid, 'fd', String(i + 3))));
      fs.mkdirSync(path.join(root, pid, 'task', pid), { recursive: true });
      fs.writeFileSync(path.join(root, pid, 'task', pid, 'children'), (children[pid] ?? []).join(' '));
    }
    return root;
  }
  const P3110 = '0100007F:0C26'; // 127.0.0.1:3110

  it('true when our pid holds the listening socket', () => {
    const root = proc({ tcp: [[P3110, '0A', 777]], fds: { 100: [777] } });
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root })).toBe(true);
  });

  it('true when a descendant of our pid holds it; IPv6 listeners count', () => {
    const root = proc({ tcp6: [['00000000000000000000000000000000:0C26', '0A', 888]], fds: { 100: [5], 101: [888] }, children: { 100: [101] } });
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root })).toBe(true);
  });

  it('false when another process listens on the port (a stale or foreign server answered)', () => {
    const root = proc({ tcp: [[P3110, '0A', 999]], fds: { 100: [777], 200: [999] } });
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root })).toBe(false);
  });

  it('false when the socket is not LISTENING or the port differs', () => {
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: proc({ tcp: [[P3110, '01', 777]], fds: { 100: [777] } }) })).toBe(false);
    expect(ownsListeningSocket({ pid: 100, port: 3111, procRoot: proc({ tcp: [[P3110, '0A', 777]], fds: { 100: [777] } }) })).toBe(false);
  });

  it('null (unknown) when /proc is not available, so the caller can fall back', () => {
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: path.join(tmp(), 'missing') })).toBeNull();
  });
});

// --- challenger delta review (L6e, L6f, pre-spawn port re-check) -------------
describe('L13 waitForOwnServer (L6e): readiness refuses a server that is not ours', () => {
  const child = (over = {}) => ({ pid: 4242, exitCode: null, signalCode: null, ...over });
  let clock = 0;
  const deps = (over = {}) => ({
    port: 3110,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 5_000,
    intervalMs: 500,
    ...over,
  });

  it('owned === true ⇒ pid-verified', async () => {
    await expect(waitForOwnServer({ child: child(), probe: async () => true, owns: () => true, ...deps() })).resolves.toBe('pid-verified');
  });

  it('owned === false ⇒ refuses: another process answers on the port', async () => {
    await expect(waitForOwnServer({ child: child(), probe: async () => true, owns: () => false, ...deps() })).rejects.toThrow(/other than/);
  });

  it('owned === null (no /proc) ⇒ relies on the port preflight', async () => {
    await expect(waitForOwnServer({ child: child(), probe: async () => true, owns: () => null, ...deps() })).resolves.toBe('port-preflight-only');
  });

  it('passes pid and port to the ownership check', async () => {
    const owns = vi.fn(() => true);
    await waitForOwnServer({ child: child(), probe: async () => true, owns, ...deps() });
    expect(owns).toHaveBeenCalledWith({ pid: 4242, port: 3110 });
  });

  it('a child that exits before it is ready fails fast (even if something answers)', async () => {
    await expect(waitForOwnServer({ child: child({ exitCode: 1 }), probe: async () => true, owns: () => true, ...deps() })).rejects.toThrow(/exited/);
  });

  it('keeps polling through connection errors; times out if never ready', async () => {
    clock = 0;
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return true;
    };
    await expect(waitForOwnServer({ child: child(), probe, owns: () => true, ...deps() })).resolves.toBe('pid-verified');
    clock = 0;
    await expect(waitForOwnServer({ child: child(), probe: async () => false, owns: () => true, ...deps() })).rejects.toThrow(/timed out/);
  });
});

describe('L14 env directory tightened (L6f)', () => {
  it('an existing 0755 state directory becomes 0700', () => {
    const root = tmp();
    const dir = path.join(root, '.ratio-local', 'p2');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeEnvFileSecure(path.join(dir, 'env'), { A: 'x' });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('L15 the app port is re-checked right before next start is spawned (no /proc platforms)', () => {
  it('portInUse sees a real listener and its absence', async () => {
    const server = net.createServer(() => undefined);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    expect(await portInUse(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await portInUse(port)).toBe(false);
  });

  it('startIfPortFree refuses (and never spawns) when the port became busy', async () => {
    const start = vi.fn(() => 'child');
    await expect(startIfPortFree({ port: 3110, isBusy: async () => true, start })).rejects.toThrow(/3110/);
    expect(start).not.toHaveBeenCalled();
    await expect(startIfPortFree({ port: 3110, isBusy: async () => false, start })).resolves.toBe('child');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('local.mjs spawns next start only through startIfPortFree and waits through waitForOwnServer', () => {
    const src = read('scripts/local/local.mjs');
    expect(src).toMatch(/startIfPortFree\(\{[\s\S]*?start: \(\) =>\s*(trackProcessGroup\(\s*)?spawn\(/);
    expect(src).toMatch(/waitForOwnServer\(\{/);
    expect(src.match(/spawn\(process\.execPath, \[path\.join\(ROOT, 'node_modules', 'next'/g)).toHaveLength(1);
  });
});

// --- Copilot 4176004971 (High): a child already killed by a signal has
// exitCode === null and signalCode !== null; waiting for 'exit' then hangs
// forever and local:test never reaches down -v. Every cleanup wait is bounded.
describe('L16 stopping next start and cleaning up never hang', () => {
  /** A child that has ALREADY exited through a signal: its 'exit' event is in the past and never fires again. */
  const signalled = () => Object.assign(new EventEmitter(), { pid: 99999, exitCode: null, signalCode: 'SIGKILL', kill: vi.fn(() => false) });
  /** A child that never exits, whatever it is sent. */
  const stuck = () => Object.assign(new EventEmitter(), { pid: 99998, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  const spawned = [];
  const sleeper = (extra = '') => {
    const c = spawn(process.execPath, ['-e', `${extra}setInterval(() => {}, 1000)`], { stdio: 'ignore' });
    spawned.push(c);
    return c;
  };
  // Never leave a sleeper behind, even when a test fails.
  afterAll(() => {
    for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });
  const exited = (c) => new Promise((r) => (childExited(c) ? r() : c.once('exit', r)));

  it('childExited: an exit code OR a signal means exited', () => {
    expect(childExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(childExited({ exitCode: null, signalCode: 'SIGTERM' })).toBe(true);
    expect(childExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it('a child already killed by a signal is recognised at once (no wait, no kill)', async () => {
    const c = signalled();
    const t0 = Date.now();
    await expect(stopChild(c, { graceMs: 30_000, killMs: 30_000 })).resolves.toBe('already-exited');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.kill).not.toHaveBeenCalled();
  }, 5_000);

  it('a REAL child SIGKILLed before the wait does not hang the wait', async () => {
    const c = sleeper();
    c.kill('SIGKILL');
    await exited(c);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBe('SIGKILL');
    const t0 = Date.now();
    await expect(stopChild(c, { graceMs: 30_000, killMs: 30_000 })).resolves.toBe('already-exited');
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 5_000);

  it('a running child that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const c = sleeper("process.on('SIGTERM', () => {}); ");
    await new Promise((r) => setTimeout(r, 300)); // let it install the handler
    await expect(stopChild(c, { graceMs: 300, killMs: 3_000 })).resolves.toBe('killed');
    expect(c.signalCode).toBe('SIGKILL');
  }, 10_000);

  it('a running child that obeys SIGTERM is stopped', async () => {
    const c = sleeper();
    await expect(stopChild(c, { graceMs: 3_000, killMs: 3_000 })).resolves.toBe('stopped');
  }, 10_000);

  it('a child that never exits is given up on after a bounded time (cleanup goes on)', async () => {
    const c = stuck();
    await expect(stopChild(c, { graceMs: 50, killMs: 50 })).resolves.toBe('unresponsive');
    expect(c.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(c.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  }, 5_000);

  it('cleanupLocalTest: with an already-signalled app, down -v still runs, once', async () => {
    const down = vi.fn(async () => undefined);
    const r = await cleanupLocalTest({ app: signalled(), down, stopOptions: { graceMs: 30_000, killMs: 30_000 } });
    expect(down).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ app: 'already-exited', down: 'ok' });
  }, 5_000);

  it('cleanupLocalTest: down -v runs even when stopping the app throws, and with no app at all', async () => {
    const down = vi.fn(async () => undefined);
    const broken = { ...stuck(), kill: () => { throw new Error('EPERM'); } };
    const r = await cleanupLocalTest({ app: broken, down, stopOptions: { graceMs: 50, killMs: 50 } });
    expect(down).toHaveBeenCalledTimes(1);
    expect(r.down).toBe('ok');
    expect(r.app).toMatch(/error/);
    expect(await cleanupLocalTest({ app: null, down })).toEqual({ app: null, down: 'ok' });
    expect(down).toHaveBeenCalledTimes(2);
  }, 5_000);

  it('cleanupLocalTest reports a failing down -v instead of throwing past the summary', async () => {
    const r = await cleanupLocalTest({ app: null, down: async () => Promise.reject(new Error('compose down failed')) });
    expect(r.down).toMatch(/compose down failed/);
  });

  it('runProcess has a bounded timeout: a hanging command is killed and rejected', async () => {
    const t0 = Date.now();
    // The child is registered so the afterAll kills it even if the timeout is broken.
    const tracked = (...a) => {
      const c = spawn(...a);
      spawned.push(c);
      return c;
    };
    await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300, spawnFn: tracked })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], { capture: true, timeoutMs: 10_000 })).resolves.toEqual({ code: 0, out: 'ok' });
    await expect(runProcess(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 })).rejects.toThrow(/exited 3/);
    await expect(runProcess(process.execPath, ['-e', 'process.exit(3)'], { allowFail: true, timeoutMs: 10_000 })).resolves.toMatchObject({ code: 3 });
  }, 10_000);

  it('local.mjs cleans up only through cleanupLocalTest, with a bounded down; no unbounded exit wait remains', () => {
    const src = read('scripts/local/local.mjs');
    // Cleanup now lives in lib.mjs's runLocalTest (Copilot 4176117561), which
    // calls cleanupLocalTest; local.mjs only hands it the body and `down`.
    expect(src).toMatch(/await runLocalTest\(\{/);
    expect(read('scripts/local/lib.mjs')).toMatch(/await cleanupLocalTest\(\{/);
    expect(src).not.toMatch(/once\('exit'/);
    expect(src).not.toMatch(/\.exitCode !== null \? /);
    expect(src).toMatch(/function run\([^)]*\) \{\s*return runProcess\(/);
    expect(src).toMatch(/timeoutMs: DOWN_TIMEOUT_MS/);
  });
});

// --- Copilot review of 551c16c: 4176117539 / 4176117553 (Medium) -------------
// Every network call, child wait and promise in scripts/local/*.mjs has a hard
// deadline. Fakes here ACCEPT the TCP connection and then never answer (or
// send headers and stall the body): the classic "alive but stuck" endpoint.
const D = { servers: [], sockets: new Set(), children: [] };
afterAll(async () => {
  for (const s of D.sockets) s.destroy();
  await Promise.all(D.servers.map((srv) => new Promise((r) => srv.close(() => r()))));
  for (const c of D.children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});
/** 'silent': accepts, reads, never writes. 'headers-only': sends 200 headers and part of the body, then stalls. */
async function stalledServer(mode = 'silent') {
  const srv = net.createServer((s) => {
    D.sockets.add(s);
    s.on('error', () => undefined);
    if (mode === 'headers-only') {
      s.once('data', () => s.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"par'));
    }
  });
  D.servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}
async function jsonServer(handler) {
  const srv = http.createServer(handler);
  D.servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}
const realSleeper = () => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  D.children.push(c);
  return c;
};
const elapsed = (t0) => Date.now() - t0;
const hello = (port) => async (signal) => (await globalThis.fetch(`http://127.0.0.1:${port}/api/hello`, { signal })).status === 200;

describe('L17 every wait in scripts/local has a hard deadline (Copilot 4176117539, 4176117553)', () => {
  it('withDeadline: the value when in time; at the deadline a rejection AND an aborted signal, even if the work ignores the signal', async () => {
    await expect(withDeadline(async () => 7, 1_000, 'x')).resolves.toBe(7);
    let seen;
    const t0 = Date.now();
    await expect(
      withDeadline((signal) => {
        seen = signal;
        return new Promise(() => undefined);
      }, 100, 'stuck thing'),
    ).rejects.toThrow(/stuck thing timed out after 100 ms/);
    expect(elapsed(t0)).toBeLessThan(1_000);
    expect(seen.aborted).toBe(true);
    await expect(withDeadline(async () => 1, undefined, 'x')).rejects.toThrow(/positive deadline/);
    await expect(withDeadline(async () => 1, 0, 'x')).rejects.toThrow(/positive deadline/);
  }, 5_000);

  it('waitUntil (local:up s3 readiness): a server that accepts TCP but never answers fails within the deadline; every attempt is aborted', async () => {
    const port = await stalledServer('silent');
    const signals = [];
    const t0 = Date.now();
    await expect(
      waitUntil({
        what: 's3',
        timeoutMs: 800,
        attemptTimeoutMs: 250,
        intervalMs: 50,
        probe: async (signal) => {
          signals.push(signal);
          return (await globalThis.fetch(`http://127.0.0.1:${port}/`, { signal })).status < 500;
        },
      }),
    ).rejects.toThrow(/timed out waiting for s3/);
    expect(elapsed(t0)).toBeLessThan(3_000);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  }, 10_000);

  it('waitUntil: the overall deadline holds even when one attempt may take longer, and when the probe ignores its signal', async () => {
    const t0 = Date.now();
    await expect(waitUntil({ what: 'x', timeoutMs: 300, attemptTimeoutMs: 60_000, intervalMs: 10, probe: () => new Promise(() => undefined) })).rejects.toThrow(/timed out waiting for x/);
    expect(elapsed(t0)).toBeLessThan(2_000);
  }, 5_000);

  it('waitUntil: keeps trying through errors and false, resolves on true; both deadlines are required', async () => {
    let n = 0;
    const probe = async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNREFUSED');
      return n >= 3;
    };
    await expect(waitUntil({ what: 'x', timeoutMs: 5_000, attemptTimeoutMs: 1_000, intervalMs: 10, probe })).resolves.toBeUndefined();
    expect(n).toBe(3);
    await expect(waitUntil({ what: 'x', timeoutMs: 5_000, intervalMs: 10, probe: async () => true })).rejects.toThrow(/attemptTimeoutMs/);
    await expect(waitUntil({ what: 'x', attemptTimeoutMs: 5_000, intervalMs: 10, probe: async () => true })).rejects.toThrow(/timeoutMs/);
  }, 10_000);

  it('waitForOwnServer (next start readiness): alive but never answering fails within the deadline; every attempt is aborted', async () => {
    const port = await stalledServer('silent');
    const signals = [];
    const t0 = Date.now();
    await expect(
      waitForOwnServer({
        child: { pid: 1, exitCode: null, signalCode: null },
        port,
        owns: () => true,
        timeoutMs: 800,
        attemptTimeoutMs: 250,
        intervalMs: 50,
        probe: async (signal) => {
          signals.push(signal);
          return hello(port)(signal);
        },
      }),
    ).rejects.toThrow(/timed out waiting for next start/);
    expect(elapsed(t0)).toBeLessThan(3_000);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  }, 10_000);

  it('waitForOwnServer: the overall deadline holds when the probe ignores its signal', async () => {
    const t0 = Date.now();
    await expect(
      waitForOwnServer({ child: { pid: 1, exitCode: null, signalCode: null }, port: 1, owns: () => true, timeoutMs: 300, attemptTimeoutMs: 60_000, intervalMs: 10, probe: () => new Promise(() => undefined) }),
    ).rejects.toThrow(/timed out/);
    expect(elapsed(t0)).toBeLessThan(2_000);
  }, 5_000);

  it('fetchJson (the API reads): no headers ever ⇒ rejects within the request deadline', async () => {
    const port = await stalledServer('silent');
    const t0 = Date.now();
    await expect(fetchJson(`http://127.0.0.1:${port}/api/v1/costs/published`, { token: 't', timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/);
    expect(elapsed(t0)).toBeLessThan(2_000);
  }, 5_000);

  it('fetchJson: headers then a stalled body ⇒ rejects within the deadline too (the body read is bounded, not swallowed)', async () => {
    const port = await stalledServer('headers-only');
    const t0 = Date.now();
    await expect(fetchJson(`http://127.0.0.1:${port}/api/v1/costs/published`, { timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/);
    expect(elapsed(t0)).toBeLessThan(2_000);
  }, 5_000);

  it('fetchJson: status and parsed body; non-JSON ⇒ body null; the token goes in the Authorization header; a deadline is required', async () => {
    const port = await jsonServer((req, res) => {
      if (req.url === '/text') return res.end('not json');
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.headers.authorization === 'Bearer tok' ? 200 : 401;
      res.end(JSON.stringify({ ok: true }));
    });
    await expect(fetchJson(`http://127.0.0.1:${port}/x`, { token: 'tok', timeoutMs: 5_000 })).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(fetchJson(`http://127.0.0.1:${port}/x`, { timeoutMs: 5_000 })).resolves.toEqual({ status: 401, body: { ok: true } });
    await expect(fetchJson(`http://127.0.0.1:${port}/text`, { timeoutMs: 5_000 })).resolves.toEqual({ status: 200, body: null });
    await expect(fetchJson(`http://127.0.0.1:${port}/x`, {})).rejects.toThrow(/positive deadline/);
  }, 10_000);

  it('local:test, readiness against a stalled server: fails within its deadline AND down -v still runs, once', async () => {
    const port = await stalledServer('silent');
    const down = vi.fn(async () => undefined);
    const t0 = Date.now();
    const summary = await runLocalTest({
      project: 'p',
      down,
      downTimeoutMs: 5_000,
      stopOptions: { graceMs: 3_000, killMs: 3_000 },
      body: async ({ steps, setApp }) => {
        const app = realSleeper();
        setApp(app);
        steps.appReady = await waitForOwnServer({ child: app, port, owns: () => true, timeoutMs: 600, attemptTimeoutMs: 200, intervalMs: 50, probe: hello(port) });
      },
    });
    expect(elapsed(t0)).toBeLessThan(6_000);
    expect(down).toHaveBeenCalledTimes(1);
    expect(summary.pass).toBe(false);
    expect(summary.error).toMatch(/timed out waiting for next start/);
    expect(summary.steps.appStop).toBe('stopped');
    expect(summary.steps.down).toBe('ok (-v)');
  }, 15_000);

  it('local:test, an API read against a stalled server: fails within its deadline AND down -v still runs, once', async () => {
    const port = await stalledServer('silent');
    const down = vi.fn(async () => undefined);
    const t0 = Date.now();
    const summary = await runLocalTest({
      project: 'p',
      down,
      downTimeoutMs: 5_000,
      stopOptions: { graceMs: 3_000, killMs: 3_000 },
      body: async ({ steps, setApp }) => {
        setApp(realSleeper());
        steps.anonymous = (await fetchJson(`http://127.0.0.1:${port}/api/v1/costs/published`, { timeoutMs: 300 })).status;
      },
    });
    expect(elapsed(t0)).toBeLessThan(6_000);
    expect(down).toHaveBeenCalledTimes(1);
    expect(summary.pass).toBe(false);
    expect(summary.error).toMatch(/timed out after 300 ms/);
    expect(summary.steps.anonymous).toBeUndefined();
    expect(summary.steps.down).toBe('ok (-v)');
  }, 15_000);

  it('cleanupLocalTest: a down -v that never settles is cut off at its deadline (recorded as an error)', async () => {
    const t0 = Date.now();
    const r = await cleanupLocalTest({ app: null, down: () => new Promise(() => undefined), downTimeoutMs: 200 });
    expect(elapsed(t0)).toBeLessThan(2_000);
    expect(r.down).toMatch(/timed out after 200 ms/);
  }, 5_000);

  it('runProcess refuses to run without a deadline (nothing is spawned)', async () => {
    const spawnFn = vi.fn();
    await expect(runProcess(process.execPath, ['-e', ''], { spawnFn })).rejects.toThrow(/timeoutMs/);
    await expect(runProcess(process.execPath, ['-e', ''], { spawnFn, timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('portInUse is bounded even when the connect attempt never settles (treated as busy: fail closed)', async () => {
    let sock;
    const connect = () => {
      sock = Object.assign(new EventEmitter(), { setTimeout: () => undefined, destroy: vi.fn() });
      return sock;
    };
    const t0 = Date.now();
    await expect(portInUse(3110, { timeoutMs: 200, connect })).resolves.toBe(true);
    expect(elapsed(t0)).toBeLessThan(2_000);
    expect(sock.destroy).toHaveBeenCalled();
  }, 5_000);

  it('ownsListeningSocket is bounded: a process walk beyond maxProcesses stops and refuses (false); cycles end', () => {
    const root = tmp();
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    fs.mkdirSync(path.join(root, 'net'), { recursive: true });
    fs.writeFileSync(path.join(root, 'net', 'tcp'), `${head}   0: 0100007F:0C26 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555 1 0000000000000000 100 0 0 10 0\n`);
    // A chain 100 -> 101 -> ... -> 109; the listener is held by 109.
    for (let pid = 100; pid <= 109; pid += 1) {
      fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
      fs.mkdirSync(path.join(root, String(pid), 'task', String(pid)), { recursive: true });
      fs.writeFileSync(path.join(root, String(pid), 'task', String(pid), 'children'), pid < 109 ? String(pid + 1) : '');
    }
    fs.symlinkSync('socket:[555]', path.join(root, '109', 'fd', '3'));
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root })).toBe(true);
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root, maxProcesses: 5 })).toBe(false);
    // A children cycle with no holder ends (false), it does not spin.
    fs.writeFileSync(path.join(root, '109', 'task', '109', 'children'), '100');
    fs.rmSync(path.join(root, '109', 'fd', '3'));
    expect(ownsListeningSocket({ pid: 100, port: 3110, procRoot: root })).toBe(false);
  });

  it('local.mjs: every fetch carries a signal, every S3 send an abortSignal, every pg Client its timeouts; waits go through waitUntil; API reads through fetchJson', () => {
    const src = read('scripts/local/local.mjs');
    expect(src).not.toMatch(/function waitFor\(/);
    expect(src).not.toMatch(/function getJson\(/);
    expect(src.match(/await waitUntil\(\{/g)?.length).toBeGreaterThanOrEqual(3); // postgres, s3, bucket warm-up
    const fetches = src.match(/\bfetch\(/g) ?? [];
    const signalled = src.match(/\bfetch\(`[^`]*`, \{ signal \}\)/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    expect(signalled.length).toBe(fetches.length);
    const sends = src.match(/\.send\(/g) ?? [];
    expect(sends.length).toBeGreaterThan(0);
    expect((src.match(/\.send\(new \w+\(\{[^)]*\}\), \{ abortSignal: signal \}\)/g) ?? []).length).toBe(sends.length);
    expect(src).toMatch(/new Client\(\{[^}]*connectionTimeoutMillis[^}]*query_timeout[^}]*statement_timeout/);
    expect(src.match(/await fetchJson\(/g)?.length).toBeGreaterThanOrEqual(2); // anonymous + paginated
    expect(src.match(/await fetchJson\([^;]*timeoutMs: API_REQUEST_TIMEOUT_MS/g)?.length).toBe(src.match(/await fetchJson\(/g).length);
    expect(read('scripts/local/lib.mjs').match(/\bfetchFn\(url, \{[^\n]*, signal \}\)/g)).toHaveLength(1);
  });

  it("the API request deadline is longer than the route's own 10 s DB statement timeout", () => {
    const pool = read('src/server/costs/readerPool.ts');
    const statementMs = Number(/statement_timeout=(\d+)/.exec(pool)[1]);
    const m = /const API_REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(read('scripts/local/local.mjs'));
    expect(m).not.toBeNull();
    const apiMs = Number(m[1].replace(/_/g, ''));
    expect(statementMs).toBe(10_000);
    expect(apiMs).toBeGreaterThanOrEqual(30_000);
    expect(apiMs).toBeGreaterThan(statementMs);
  });
});

// --- Copilot 4176117561 (Medium) + challenger Low 1/Low 2: the pass/fail of a
// local:test run is one pure function over (body error, app stop, down). -----
describe('L18 local:test summary finalisation', () => {
  const APP = [null, 'stopped', 'killed', 'already-exited', 'unresponsive', 'error: EPERM', 'something-new'];
  const DOWN = ['ok', 'error: compose down failed'];
  const ERR = [null, 'reader totals differ'];
  const cases = ERR.flatMap((error) => APP.flatMap((app) => DOWN.map((down) => ({ error, app, down }))));

  it.each(cases)('error=$error app=$app down=$down', ({ error, app, down }) => {
    const s = finalizeLocalTestSummary({ project: 'p', steps: { up: 'ok' }, error, cleanup: { app, down } });
    const expected = error === null && (app === 'stopped' || app === 'killed') && down === 'ok';
    expect(s.pass).toBe(expected);
    // Every result is recorded, pass or fail.
    expect(s.project).toBe('p');
    expect(s.steps.up).toBe('ok');
    expect(s.steps.appStop).toBe(app);
    expect(s.steps.down).toBe(down === 'ok' ? 'ok (-v)' : down);
    if (error) expect(s.error).toBe(error);
    if (expected) expect(s.failures).toEqual([]);
    else expect(s.failures.length).toBeGreaterThan(0);
  });

  it('T1: a failing down -v alone fails the run', () => {
    const s = finalizeLocalTestSummary({ project: 'p', steps: {}, error: null, cleanup: { app: 'stopped', down: 'error: compose down failed' } });
    expect(s.pass).toBe(false);
    expect(s.failures.join('\n')).toMatch(/down -v.*compose down failed/);
  });

  it('an unresponsive app alone fails the run (down still recorded ok)', () => {
    const s = finalizeLocalTestSummary({ project: 'p', steps: {}, error: null, cleanup: { app: 'unresponsive', down: 'ok' } });
    expect(s.pass).toBe(false);
    expect(s.steps.down).toBe('ok (-v)');
    expect(s.failures.join('\n')).toMatch(/next start.*unresponsive/);
  });

  it('an error stopping the app alone fails the run', () => {
    const s = finalizeLocalTestSummary({ project: 'p', steps: {}, error: null, cleanup: { app: 'error: EPERM', down: 'ok' } });
    expect(s.pass).toBe(false);
    expect(s.failures.join('\n')).toMatch(/EPERM/);
  });

  it('an app that had already exited, or was never started, fails an otherwise passing run (it should still have been serving)', () => {
    for (const app of ['already-exited', null]) {
      expect(finalizeLocalTestSummary({ project: 'p', steps: {}, error: null, cleanup: { app, down: 'ok' } }).pass).toBe(false);
    }
  });

  it('runLocalTest: a passing body with a clean stop and down passes; a stuck app fails it after down -v ran', async () => {
    const down = vi.fn(async () => undefined);
    const ok = await runLocalTest({
      project: 'p',
      down,
      downTimeoutMs: 5_000,
      stopOptions: { graceMs: 3_000, killMs: 3_000 },
      body: async ({ steps, setApp }) => {
        setApp(realSleeper());
        steps.api = 'ok';
      },
    });
    expect(ok).toMatchObject({ pass: true, failures: [], steps: { api: 'ok', appStop: 'stopped', down: 'ok (-v)' } });
    const stuckApp = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null, kill: () => true });
    const bad = await runLocalTest({ project: 'p', down, downTimeoutMs: 5_000, stopOptions: { graceMs: 50, killMs: 50 }, body: async ({ setApp }) => setApp(stuckApp) });
    expect(bad.pass).toBe(false);
    expect(bad.steps.appStop).toBe('unresponsive');
    expect(down).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('local.mjs records the app right after spawning it, prints the summary and exits non-zero unless summary.pass', () => {
    const src = read('scripts/local/local.mjs');
    expect(src).toMatch(/const app = await startIfPortFree\(\{[\s\S]*?\}\);\s*setApp\(app\);/);
    expect(src).toMatch(/process\.stdout\.write\(`\$\{JSON\.stringify\(\{ type: 'ratio\.local-test', \.\.\.summary \}\)\}\\n`\);/);
    // The exit code now also covers an interrupt (130/143): localTestExitCode, tested in L20.
    expect(src).toMatch(/return localTestExitCode\(summary\);/);
    expect(src).toMatch(/return \(await COMMANDS\[cmd\]\(localSettings\(process\.env\), args\)\) \?\? 0;/);
    expect(src).not.toMatch(/summary\.pass = /); // only finalizeLocalTestSummary decides
  });
});

// --- challenger Low 1 on b27f4ba: runProcess with capture: true settled only
// on 'close', which never fires while a GRANDCHILD holds the stdout pipe, so
// the deadline was not hard. Every case below must settle within its bound and
// leave no process behind.
describe('L19 runProcess deadline is hard even when a grandchild holds stdio (challenger Low 1)', () => {
  /** pids whose cmdline contains `marker` (Linux /proc). */
  const pidsWith = (marker) =>
    fs
      .readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(marker);
        } catch {
          return false;
        }
      })
      .map(Number);
  const markers = [];
  const marker = () => {
    const m = `${30 + markers.length}.${Math.floor(Math.random() * 900) + 100}`;
    markers.push(m);
    return m;
  };
  afterAll(() => {
    for (const m of markers) {
      for (const pid of pidsWith(`sleep\0${m}`)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });
  const gone = async (m) => {
    for (let i = 0; i < 20; i += 1) {
      if (pidsWith(`sleep\0${m}`).length === 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it('capture: a child and a grandchild both holding the pipe ⇒ rejects at the deadline; the whole group is killed', async () => {
    const m = marker();
    const t0 = Date.now();
    await expect(runProcess('bash', ['-c', `(sleep ${m}) & sleep ${m}`], { capture: true, timeoutMs: 500 })).rejects.toThrow(/timed out after 500 ms/);
    expect(elapsed(t0)).toBeLessThan(2_000);
    expect(await gone(m)).toBe(true);
  }, 10_000);

  it('no capture (inherited stdio): the same holds', async () => {
    const m = marker();
    const t0 = Date.now();
    await expect(runProcess('bash', ['-c', `(sleep ${m}) & sleep ${m}`], { timeoutMs: 500 })).rejects.toThrow(/timed out after 500 ms/);
    expect(elapsed(t0)).toBeLessThan(2_000);
    expect(await gone(m)).toBe(true);
  }, 10_000);

  it('capture: a child that exits at once but leaves a grandchild on the pipe settles after a short grace (its exit code), and the grandchild is killed', async () => {
    const m = marker();
    const t0 = Date.now();
    await expect(runProcess('bash', ['-c', `echo hi; (sleep ${m}) & exit 0`], { capture: true, timeoutMs: 10_000, exitGraceMs: 300 })).resolves.toEqual({ code: 0, out: 'hi\n' });
    expect(elapsed(t0)).toBeLessThan(3_000);
    expect(await gone(m)).toBe(true);
  }, 15_000);

  it('capture: the same with a grace longer than the deadline ⇒ rejects at the deadline', async () => {
    const m = marker();
    const t0 = Date.now();
    await expect(runProcess('bash', ['-c', `(sleep ${m}) & exit 0`], { capture: true, timeoutMs: 500, exitGraceMs: 60_000 })).rejects.toThrow(/timed out after 500 ms/);
    expect(elapsed(t0)).toBeLessThan(2_000);
    expect(await gone(m)).toBe(true);
  }, 10_000);

  it('a non-zero exit is still reported while the pipe is held (exit code, not a hang)', async () => {
    const m = marker();
    await expect(runProcess('bash', ['-c', `(sleep ${m}) & exit 4`], { capture: true, timeoutMs: 10_000, exitGraceMs: 300 })).rejects.toThrow(/exited 4/);
    expect(await gone(m)).toBe(true);
  }, 15_000);

  it('local.mjs kills every live process group on SIGINT/SIGTERM (runProcess spawns each command in its own group)', () => {
    const src = read('scripts/local/local.mjs');
    // Since Copilot 4176238924 the handlers are installInterruptHandlers (L20); they still kill the live groups.
    expect(src).toMatch(/installInterruptHandlers\(\{[\s\S]*?killLiveProcessGroups\(\)[\s\S]*?onForce: \(sig\) => \{\s*killLiveProcessGroups\(\)/);
    expect(read('scripts/local/lib.mjs')).toMatch(/detached: true/);
  });
});

// --- Copilot 4176238924: SIGINT/SIGTERM during local:test must go through the
// normal bounded cleanup (stop the app, down -v), then exit 130/143; a second
// signal forces an immediate exit. next start is tracked with the other groups.
describe('L20 an interrupted local:test still cleans up (Copilot 4176238924)', () => {
  const spawnedHere = [];
  afterAll(() => {
    for (const c of spawnedHere) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });
  /** A detached sleeper tracked like next start. */
  const trackedSleeper = () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    spawnedHere.push(c);
    return trackProcessGroup(c);
  };
  const exitedWithin = (c, ms) =>
    new Promise((r) => {
      if (childExited(c)) return r(true);
      const t = setTimeout(() => r(false), ms);
      c.once('exit', () => {
        clearTimeout(t);
        r(true);
      });
    });

  it('exit codes: SIGINT 130, SIGTERM 143; an interrupted run exits with them even if everything else passed', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
    expect(localTestExitCode({ pass: true, failures: [] })).toBe(0);
    expect(localTestExitCode({ pass: false, failures: ['x'] })).toBe(1);
    expect(localTestExitCode({ pass: false, interrupted: 'SIGINT' })).toBe(130);
    expect(localTestExitCode({ pass: false, interrupted: 'SIGTERM' })).toBe(143);
    expect(localTestExitCode({ pass: true, interrupted: 'SIGINT' })).toBe(130);
  });

  it('SIGINT mid-body: the in-flight command is killed, the app is stopped, down -v runs exactly once, the run fails with interrupted=SIGINT (exit 130)', async () => {
    const ac = new AbortController();
    const down = vi.fn(async () => undefined);
    let inFlight;
    const t0 = Date.now();
    setTimeout(() => ac.abort('SIGINT'), 300);
    const summary = await runLocalTest({
      project: 'p',
      down,
      downTimeoutMs: 5_000,
      stopOptions: { graceMs: 3_000, killMs: 3_000 },
      signal: ac.signal,
      body: async ({ steps, setApp, signal }) => {
        setApp(trackedSleeper());
        steps.up = 'started';
        // A long command (like compose up or the worker), bound to the run's signal.
        const p = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          timeoutMs: 60_000,
          signal,
          spawnFn: (...a) => {
            inFlight = spawn(...a);
            spawnedHere.push(inFlight);
            return inFlight;
          },
        });
        await p;
        steps.after = 'never';
      },
    });
    expect(elapsed(t0)).toBeLessThan(5_000);
    expect(down).toHaveBeenCalledTimes(1);
    expect(summary.interrupted).toBe('SIGINT');
    expect(summary.pass).toBe(false);
    expect(summary.error).toMatch(/interrupted by SIGINT/);
    expect(summary.steps.appStop).toBe('stopped');
    expect(summary.steps.down).toBe('ok (-v)');
    expect(summary.steps.after).toBeUndefined();
    expect(await exitedWithin(inFlight, 2_000)).toBe(true);
    expect(localTestExitCode(summary)).toBe(130);
  }, 15_000);

  it('SIGTERM while the body ignores every signal: cleanup still runs once (exit 143)', async () => {
    const ac = new AbortController();
    const down = vi.fn(async () => undefined);
    setTimeout(() => ac.abort('SIGTERM'), 100);
    const summary = await runLocalTest({ project: 'p', down, downTimeoutMs: 5_000, signal: ac.signal, body: () => new Promise(() => undefined) });
    expect(down).toHaveBeenCalledTimes(1);
    expect(summary.interrupted).toBe('SIGTERM');
    expect(localTestExitCode(summary)).toBe(143);
  }, 10_000);

  it('a signal that arrives during the cleanup is recorded (exit 130) and does not run the cleanup twice', async () => {
    const ac = new AbortController();
    const down = vi.fn(async () => {
      ac.abort('SIGINT');
      await new Promise((r) => setTimeout(r, 50));
    });
    const summary = await runLocalTest({ project: 'p', down, downTimeoutMs: 5_000, signal: ac.signal, body: async () => undefined });
    expect(down).toHaveBeenCalledTimes(1);
    expect(summary.interrupted).toBe('SIGINT');
    expect(localTestExitCode(summary)).toBe(130);
  }, 10_000);

  it('runProcess bound to an aborted signal never spawns; aborting mid-run kills the group and rejects at once', async () => {
    const spawnFn = vi.fn();
    const pre = new AbortController();
    pre.abort('SIGINT');
    await expect(runProcess(process.execPath, ['-e', ''], { timeoutMs: 5_000, signal: pre.signal, spawnFn })).rejects.toThrow(/interrupted/);
    expect(spawnFn).not.toHaveBeenCalled();
    const ac = new AbortController();
    let child;
    const t0 = Date.now();
    setTimeout(() => ac.abort('SIGTERM'), 200);
    await expect(
      runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 60_000,
        signal: ac.signal,
        spawnFn: (...a) => {
          child = spawn(...a);
          spawnedHere.push(child);
          return child;
        },
      }),
    ).rejects.toThrow(/interrupted/);
    expect(elapsed(t0)).toBeLessThan(3_000);
    expect(await exitedWithin(child, 2_000)).toBe(true);
  }, 10_000);

  it('installInterruptHandlers: the first signal calls onFirst once; a second one forces (onForce); dispose removes the listeners', () => {
    const proc = new EventEmitter();
    const onFirst = vi.fn();
    const onForce = vi.fn();
    const dispose = installInterruptHandlers({ proc, onFirst, onForce });
    proc.emit('SIGINT', 'SIGINT');
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onFirst).toHaveBeenCalledWith('SIGINT');
    expect(onForce).not.toHaveBeenCalled();
    proc.emit('SIGTERM', 'SIGTERM');
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledWith('SIGTERM');
    dispose();
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('next start style children are tracked: killLiveProcessGroups kills them; an exited child leaves the set', async () => {
    const c = trackedSleeper();
    expect(liveProcessGroups()).toContain(c.pid);
    killLiveProcessGroups();
    expect(await exitedWithin(c, 2_000)).toBe(true);
    expect(liveProcessGroups()).not.toContain(c.pid);
    const d = trackedSleeper();
    d.kill('SIGKILL');
    await exitedWithin(d, 2_000);
    expect(liveProcessGroups()).not.toContain(d.pid);
  }, 10_000);

  it('local.mjs: next start is detached and tracked; the first signal aborts local:test (cleanup), other commands kill and exit; a second signal forces; down ignores the interrupt', () => {
    const src = read('scripts/local/local.mjs');
    expect(src).toMatch(/start: \(\) =>\s*trackProcessGroup\(\s*spawn\(process\.execPath, \[path\.join\(ROOT, 'node_modules', 'next'[\s\S]*?detached: true/);
    expect(src).toMatch(/installInterruptHandlers\(\{/);
    expect(src).toMatch(/onFirst: \(sig\) => \{\s*if \(COMMAND === 'test'\) \{\s*[\s\S]{0,200}?interrupt\.abort\(sig\);\s*return;\s*\}\s*killLiveProcessGroups\(\);/);
    expect(src).toMatch(/onForce: \(sig\) => \{\s*killLiveProcessGroups\(\);[\s\S]{0,200}?process\.exit\(exitCodeForSignal\(sig\)\);/);
    expect(src).toMatch(/runLocalTest\(\{[\s\S]*?signal: interrupt\.signal,/);
    expect(src).toMatch(/'down', '--remove-orphans', [^\n]*\], \{ timeoutMs, signal: null \}\)/);
    expect(src).not.toMatch(/process\.once\(sig/);
  });
});
