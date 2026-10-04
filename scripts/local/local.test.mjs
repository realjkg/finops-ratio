// Static/pure tests of the local stack tooling (no Docker, no database):
// generated local secrets, the env state file, settings validation, the role
// bootstrap plan (no dangerous attribute or membership), the compose file
// (loopback-only ports, digest-pinned images, no trust auth), .env.example
// (names only) and the control-total comparison used by `local:test`.
import { afterAll, describe, expect, it } from 'vitest';
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
  preflightProblems,
  removeProjectState,
  serializeEnvFile,
  writeEnvFileSecure,
} from './lib.mjs';
import { bootstrapPlan } from './bootstrap.mjs';

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
    { billingPeriod: '2026-07-01', billingCurrency: 'USD', rowCount: 55, billedCost: '30.8272954899' },
    { billingPeriod: '2026-08-01', billingCurrency: 'USD', rowCount: 40, billedCost: '21.0978157665' },
  ];

  it('equal totals ⇒ no mismatch', () => {
    expect(compareControlTotals(totals, control)).toEqual([]);
  });

  it('exact strings: a different scale, a different value, a count, a missing or an extra period all mismatch', () => {
    const mut = (i, patch) => totals.map((t, j) => (j === i ? { ...t, ...patch } : t));
    expect(compareControlTotals(mut(0, { billedCost: '30.82729548990' }), control)).toHaveLength(1);
    expect(compareControlTotals(mut(0, { billedCost: '30.8272954898' }), control)).toHaveLength(1);
    expect(compareControlTotals(mut(1, { rowCount: 39 }), control)).toHaveLength(1);
    expect(compareControlTotals(totals.slice(1), control)).toHaveLength(1);
    expect(compareControlTotals([...totals, { billingPeriod: '2026-09-01', billingCurrency: 'USD', rowCount: 1, billedCost: '1' }], control)).toHaveLength(1);
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
