#!/usr/bin/env node
// LOCAL, EPHEMERAL Ratio stack (Slice 2). Not a production tool.
//
//   npm run local:up        docker compose up (Postgres 16 + SeaweedFS S3), then the role bootstrap
//   npm run local:migrate   worker:build, migrate as the non-superuser migrator, status must match
//   npm run local:seed      buckets, the committed SYNTHETIC FOCUS fixture, tenant + source
//   npm run local:sync      worker sync as the ratio_worker login
//   npm run local:down      docker compose down        (-- -v: also volumes and .ratio-local/<project>/)
//   npm run local:test      its OWN stack: preflight → up → migrate → seed → sync → API read
//                           under next start → assert control totals → down -v
//
// Every command is idempotent. Secrets are generated on the first `up` into
// .ratio-local/<project>/env (gitignored; directory 0700, file 0600); nothing
// secret is committed. Settings (env): RATIO_LOCAL_PROJECT (ratio-local),
// RATIO_LOCAL_PG_PORT (54329), RATIO_LOCAL_S3_PORT (18343),
// RATIO_LOCAL_APP_PORT (3100). local:test ignores those and uses
// RATIO_LOCAL_TEST_PROJECT (ratio-local-test), RATIO_LOCAL_TEST_PG_PORT
// (54339), RATIO_LOCAL_TEST_S3_PORT (18353), RATIO_LOCAL_TEST_APP_PORT (3110),
// refusing any overlap with the developer stack. All ports bind 127.0.0.1 only.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers';

const { fetch } = globalThis;
import {
  LOCAL_NAMES,
  apiEnv,
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
  workerEnv,
  writeEnvFileSecure,
} from './lib.mjs';
import { runBootstrap } from './bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.local.yml');
const FIXTURE_BASE = path.join(ROOT, 'fixtures', 'focus-1.0-synthetic', 'base');
const CONTROL_TOTALS = path.join(ROOT, 'fixtures', 'focus-1.0-synthetic', 'control-totals.json');

const log = (msg, fields = {}) => process.stderr.write(`${JSON.stringify({ tag: 'ratio-local', msg, ...fields })}\n`);

// --- state (per compose project) ------------------------------------------------

const envFileOf = (settings) => path.join(ROOT, localStatePaths(settings.project).envFile);

function loadSecrets(settings, { create }) {
  const file = envFileOf(settings);
  if (fs.existsSync(file)) return parseEnvFile(fs.readFileSync(file, 'utf8'));
  if (!create) throw new Error(`${localStatePaths(settings.project).envFile} not found: run npm run local:up first`);
  const secrets = generateLocalSecrets();
  writeEnvFileSecure(file, secrets);
  log('generated local secrets', { file: localStatePaths(settings.project).envFile });
  return secrets;
}

// --- processes ---------------------------------------------------------------

function run(cmd, args, { env = {}, capture = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let out = '';
    if (capture) child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFail) reject(new Error(`${cmd} ${args[0] ?? ''} exited ${code}`));
      else resolve({ code, out });
    });
  });
}

function composeEnv(settings, secrets) {
  return {
    RATIO_LOCAL_PG_PORT: String(settings.pgPort),
    RATIO_LOCAL_S3_PORT: String(settings.s3Port),
    RATIO_LOCAL_APP_PORT: String(settings.appPort),
    ...secrets,
  };
}

const compose = (settings, secrets, args, opts = {}) =>
  run('docker', ['compose', '-f', COMPOSE_FILE, '-p', settings.project, ...args], { ...opts, env: { ...composeEnv(settings, secrets), ...(opts.env ?? {}) } });

async function withClient(url, fn) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function waitFor(what, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const superUrl = (settings, secrets) =>
  connectionUrl({ user: 'postgres', password: secrets.RATIO_LOCAL_PG_SUPERUSER_PASSWORD, port: settings.pgPort, database: 'postgres' });

// --- commands ----------------------------------------------------------------

async function up(settings) {
  const secrets = loadSecrets(settings, { create: true });
  await compose(settings, secrets, ['up', '-d', '--wait', 'postgres', 's3']);
  await waitFor('postgres', () => withClient(superUrl(settings, secrets), async (c) => (await c.query('SELECT 1')).rowCount === 1));
  await waitFor('s3', async () => {
    const r = await fetch(`http://127.0.0.1:${settings.s3Port}/`);
    return r.status < 500;
  });
  await withClient(superUrl(settings, secrets), async (c) => {
    const v = await c.query(`SELECT current_setting('server_version_num') AS v`);
    if (!/^16\d{4}$/.test(v.rows[0].v)) throw new Error(`the local Postgres is not version 16 (server_version_num ${v.rows[0].v})`);
    await runBootstrap(c, LOCAL_NAMES, {
      [LOCAL_NAMES.migrator]: secrets.RATIO_LOCAL_MIGRATOR_PASSWORD,
      [LOCAL_NAMES.worker]: secrets.RATIO_LOCAL_WORKER_PASSWORD,
      [LOCAL_NAMES.reader]: secrets.RATIO_LOCAL_READER_PASSWORD,
    });
  });
  log('up: postgres 16 + s3 running, roles bootstrapped', { project: settings.project, pgPort: settings.pgPort, s3Port: settings.s3Port });
}

async function workerCli(settings, secrets, args, opts = {}) {
  if (!fs.existsSync(path.join(ROOT, 'dist-worker', 'ingest', 'cli.js'))) await run('npm', ['run', '-s', 'worker:build']);
  return run(process.execPath, [path.join(ROOT, 'dist-worker', 'ingest', 'cli.js'), ...args], { env: workerEnv(settings, secrets), capture: true, ...opts });
}

async function migrate(settings) {
  const secrets = loadSecrets(settings, { create: false });
  await run('npm', ['run', '-s', 'worker:build']);
  await workerCli(settings, secrets, ['migrate']);
  const status = await workerCli(settings, secrets, ['migrate', '--status', '--json'], { allowFail: true });
  const doc = JSON.parse(status.out);
  // Slice 0's catalog check judged the bootstrapped logins: no privilege problem may be reported.
  if (status.code !== 0 || !doc.matches || doc.privilegeProblems?.length) {
    throw new Error(`migrate --status: exit ${status.code}, matches ${doc.matches}, privilegeProblems ${JSON.stringify(doc.privilegeProblems)}`);
  }
  log('migrate: schema current, Slice 0 privilege model satisfied', { currentVersion: doc.currentVersion, privilegeProblems: doc.privilegeProblems });
  return doc;
}

function fixtureFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) fixtureFiles(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

function s3Client(settings, secrets) {
  const { S3Client } = require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-s3'));
  return new S3Client({
    endpoint: `http://127.0.0.1:${settings.s3Port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: secrets.RATIO_LOCAL_S3_ACCESS_KEY_ID, secretAccessKey: secrets.RATIO_LOCAL_S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function seed(settings) {
  const secrets = loadSecrets(settings, { create: false });
  const { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand } = require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-s3'));
  const s3 = s3Client(settings, secrets);
  try {
    for (const Bucket of [LOCAL_NAMES.sourceBucket, LOCAL_NAMES.evidenceBucket]) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket }));
      } catch (e) {
        if (e?.name !== 'BucketAlreadyOwnedByYou' && e?.name !== 'BucketAlreadyExists') throw e;
      }
      // A fresh SeaweedFS bucket answers 500 until its volumes are allocated:
      // warm it with a probe object so the worker's first evidence write does
      // not spend its bounded retries on that (seen locally: 2 retries).
      await waitFor(`s3 bucket ${Bucket} writable`, async () => {
        await s3.send(new PutObjectCommand({ Bucket, Key: '.ratio-local-warmup', Body: 'warmup' }));
        await s3.send(new DeleteObjectCommand({ Bucket, Key: '.ratio-local-warmup' }));
        return true;
      }, 60_000);
    }
    const files = fixtureFiles(FIXTURE_BASE);
    for (const f of files) {
      const Key = path.relative(FIXTURE_BASE, f).split(path.sep).join('/');
      await s3.send(new PutObjectCommand({ Bucket: LOCAL_NAMES.sourceBucket, Key, Body: fs.readFileSync(f) }));
    }
    log('seed: SYNTHETIC fixture uploaded', { bucket: LOCAL_NAMES.sourceBucket, objects: files.length });
  } finally {
    s3.destroy();
  }
  const migratorUrl = workerEnv(settings, secrets).RATIO_MIGRATE_DATABASE_URL;
  await withClient(migratorUrl, async (c) => {
    // Provisioning is an owner action (ingestion-ops SKILL §2); RLS applies to the owner too.
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [secrets.RATIO_LOCAL_TENANT_ID]);
      await c.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [secrets.RATIO_LOCAL_TENANT_ID, LOCAL_NAMES.tenantSlug]);
      await c.query(
        `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, config)
         VALUES ($1, gen_random_uuid(), $2, 'focus_file', 'SYNTHETIC local FOCUS fixture (not real data)', 'public_cloud', '1.0', $3::jsonb)
         ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [
          secrets.RATIO_LOCAL_TENANT_ID,
          LOCAL_NAMES.sourceKey,
          JSON.stringify({ layout: 'aws-data-exports', bucket: LOCAL_NAMES.sourceBucket, prefix: LOCAL_NAMES.fixturePrefix, exportName: LOCAL_NAMES.fixtureExportName }),
        ],
      );
      const commit = await c.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('provisioning transaction was rolled back');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
  log('seed: tenant and source provisioned', { tenant: secrets.RATIO_LOCAL_TENANT_ID, source: LOCAL_NAMES.sourceKey });
}

async function sync(settings) {
  const secrets = loadSecrets(settings, { create: false });
  const r = await workerCli(settings, secrets, ['sync', '--tenant', secrets.RATIO_LOCAL_TENANT_ID, '--source', LOCAL_NAMES.sourceKey], { allowFail: true });
  process.stdout.write(r.out);
  if (r.code !== 0) throw new Error(`worker sync exited ${r.code}`);
  return JSON.parse(r.out.trim().split('\n').pop());
}

async function down(settings, { volumes }) {
  // Compose interpolates the whole file even for `down`: give it the real or a placeholder password.
  const file = envFileOf(settings);
  const secrets = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : { RATIO_LOCAL_PG_SUPERUSER_PASSWORD: 'unused-for-down' };
  await compose(settings, secrets, ['--profile', 'app', '--profile', 'worker', 'down', '--remove-orphans', ...(volumes ? ['-v'] : [])]);
  if (volumes) removeProjectState(ROOT, settings.project);
  log(volumes ? 'down: containers, network, volumes and local secrets removed' : 'down: containers and network removed (volumes kept)', { project: settings.project });
}

// --- end to end ----------------------------------------------------------------

async function getJson(url, token) {
  const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
function portInUse(p) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: p });
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
 * Waits until `next start` answers AND the answering server is the process
 * we spawned: fails fast if the child exits; on Linux the listening socket
 * must belong to the child (or a descendant); without /proc the pre-start
 * port check is what guarantees no other server sits on the port.
 */
async function waitForOwnServer(child, appPort, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`next start exited (code ${child.exitCode}, signal ${child.signalCode}) before it was ready`);
    let ok;
    try {
      ok = (await fetch(`http://127.0.0.1:${appPort}/api/hello`)).status === 200;
    } catch {
      ok = false;
    }
    if (ok) {
      const owned = ownsListeningSocket({ pid: child.pid, port: appPort });
      if (owned === false) throw new Error(`a process other than the next start we spawned answers on port ${appPort}`);
      return owned === true ? 'pid-verified' : 'port-preflight-only';
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for next start');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function localTest() {
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no Next.js build: run `npm run build` first');
  // local:test owns its stack end to end (down -v at the end), so it uses its
  // OWN project and ports and refuses to start over anything already there.
  const settings = localTestSettings(process.env);
  const containers = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${settings.project}`], { capture: true })).out.split('\n').filter(Boolean).length;
  const busyPorts = [];
  for (const p of [settings.pgPort, settings.s3Port, settings.appPort]) if (await portInUse(p)) busyPorts.push(p);
  const problems = preflightProblems({ stateExists: fs.existsSync(path.join(ROOT, localStatePaths(settings.project).dir)), containers, busyPorts });
  if (problems.length) throw new Error(`local:test refuses to start (nothing was changed):\n  ${problems.join('\n  ')}`);
  const summary = { project: settings.project, steps: {} };
  let app;
  try {
    await up(settings);
    await up(settings); // idempotent
    summary.steps.up = 'ok (twice)';
    const status = await migrate(settings);
    await migrate(settings); // idempotent
    summary.steps.migrate = { currentVersion: status.currentVersion, privilegeProblems: status.privilegeProblems };
    await seed(settings);
    await seed(settings); // idempotent
    summary.steps.seed = 'ok (twice)';
    const first = await sync(settings);
    const outcomes = (rec) => Object.fromEntries((rec.results?.periods ?? []).map((p) => [p.billingPeriod, p.outcome]));
    summary.steps.sync = outcomes(first);
    const second = await sync(settings);
    summary.steps.syncAgain = outcomes(second);
    if (Object.values(summary.steps.sync).some((o) => o !== 'published')) throw new Error(`first sync did not publish every period: ${JSON.stringify(summary.steps.sync)}`);
    if (Object.values(summary.steps.syncAgain).some((o) => o !== 'skipped_unchanged')) throw new Error(`second sync was not a no-op: ${JSON.stringify(summary.steps.syncAgain)}`);

    const secrets = loadSecrets(settings, { create: false });
    const base = `http://127.0.0.1:${settings.appPort}`;
    app = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(settings.appPort), '-H', '127.0.0.1'], {
      cwd: ROOT,
      env: { ...process.env, ...apiEnv(settings, secrets), NODE_ENV: 'production' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    summary.steps.appReady = await waitForOwnServer(app, settings.appPort);

    const anon = await getJson(`${base}/api/v1/costs/published`);
    if (anon.status !== 401) throw new Error(`anonymous read answered ${anon.status}, expected 401`);
    summary.steps.anonymous = anon.status;

    const rows = [];
    let totals = null;
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const r = await getJson(`${base}/api/v1/costs/published?limit=17${cursor ? `&cursor=${cursor}` : ''}`, secrets.RATIO_LOCAL_API_TOKEN);
      if (r.status !== 200) throw new Error(`API read answered ${r.status}: ${JSON.stringify(r.body)}`);
      if (page === 0) totals = r.body.totals;
      rows.push(...r.body.data);
      cursor = r.body.page.nextCursor;
      if (!cursor) break;
    }
    const control = JSON.parse(fs.readFileSync(CONTROL_TOTALS, 'utf8')).base;
    const mismatches = compareControlTotals(totals ?? [], control);
    const keys = new Set(rows.map((r) => `${r.batchId}/${r.artifactSha256}/${r.rowOrdinal}`));
    const expectedRows = Object.values(control).reduce((n, c) => n + c.rowCount, 0);
    if (rows.length !== expectedRows || keys.size !== expectedRows) mismatches.push(`rows over all pages: ${rows.length} (${keys.size} distinct), expected ${expectedRows}`);
    if (rows.some((r) => typeof r.billedCost !== 'string')) mismatches.push('a billedCost is not a decimal string');
    summary.steps.api = { totals, rows: rows.length, distinct: keys.size };
    if (mismatches.length) throw new Error(`reader totals differ from the fixture control totals:\n  ${mismatches.join('\n  ')}`);
    summary.pass = true;
  } catch (e) {
    summary.pass = false;
    summary.error = e.message;
  } finally {
    if (app) {
      app.kill('SIGTERM');
      await new Promise((r) => (app.exitCode !== null ? r() : app.once('exit', r)));
    }
    try {
      await down(settings, { volumes: true });
      summary.steps.down = 'ok (-v)';
    } catch (e) {
      summary.pass = false;
      summary.downError = e.message;
    }
  }
  process.stdout.write(`${JSON.stringify({ type: 'ratio.local-test', ...summary })}\n`);
  if (!summary.pass) throw new Error(summary.error ?? summary.downError ?? 'local:test failed');
}

// --- main ----------------------------------------------------------------------

const COMMANDS = {
  up: (s) => up(s),
  migrate: (s) => migrate(s),
  seed: (s) => seed(s),
  sync: (s) => sync(s),
  down: (s, args) => down(s, { volumes: args.includes('-v') || args.includes('--volumes') }),
  test: () => localTest(),
};

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!COMMANDS[cmd]) {
    process.stderr.write(`usage: node scripts/local/local.mjs <${Object.keys(COMMANDS).join('|')}> [-v]\n`);
    return 2;
  }
  await COMMANDS[cmd](localSettings(process.env), args);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    log('failed', { error: e.message });
    process.exit(1);
  },
);
