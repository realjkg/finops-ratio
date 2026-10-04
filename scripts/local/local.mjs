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
//   npm run local:acceptance [-- --dataset 1k|10k] [--mutation <kind>]
//                           (Slice 2b) its OWN stack, like local:test, on the public
//                           FOCUS 1.0 Sample Data: control totals (python3) → stage as
//                           AWS Data Exports → up → migrate → seed → sync ×2 → API read
//                           → exact comparison, evidence re-hash, catalog → down -v.
//                           Settings: RATIO_LOCAL_ACCEPTANCE_PROJECT (ratio-local-acceptance),
//                           RATIO_LOCAL_ACCEPTANCE_{PG,S3,APP}_PORT (54349, 18363, 3120).
//
// Every command is idempotent. Secrets are generated on the first `up` into
// .ratio-local/<project>/env (gitignored; directory 0700, file 0600); nothing
// secret is committed. Settings (env): RATIO_LOCAL_PROJECT (ratio-local),
// RATIO_LOCAL_PG_PORT (54329), RATIO_LOCAL_S3_PORT (18343),
// RATIO_LOCAL_APP_PORT (3100). local:test ignores those and uses
// RATIO_LOCAL_TEST_PROJECT (ratio-local-test), RATIO_LOCAL_TEST_PG_PORT
// (54339), RATIO_LOCAL_TEST_S3_PORT (18353), RATIO_LOCAL_TEST_APP_PORT (3110),
// refusing any overlap with the developer stack. All ports bind 127.0.0.1 only.
//
// Every child process, network call and wait below has a HARD deadline (the
// *_TIMEOUT_MS constants; the full inventory is in
// docs/evidence/slice-2/EVIDENCE.md §13): nothing here can hang `local:up`,
// and local:test always reaches its `down -v`.
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { AbortController, AbortSignal, fetch } = globalThis;
import {
  LOCAL_NAMES,
  apiEnv,
  compareControlTotals,
  connectionUrl,
  exitCodeForSignal,
  fetchJson,
  generateLocalSecrets,
  installInterruptHandlers,
  killLiveProcessGroups,
  localSettings,
  localStatePaths,
  localTestExitCode,
  localTestSettings,
  portInUse,
  parseEnvFile,
  preflightProblems,
  removeProjectState,
  runLocalTest,
  runProcess,
  startIfPortFree,
  trackProcessGroup,
  waitForOwnServer,
  waitUntil,
  withDeadline,
  workerEnv,
  writeEnvFileSecure,
} from './lib.mjs';
import { runBootstrap } from './bootstrap.mjs';
import {
  CONTROL_TOTALS_FILE as SAMPLE_CONTROL_TOTALS_FILE,
  SAMPLE_NAMES,
  artifactSetProblems,
  rowProblems,
  UPSTREAM_COMPARED_FIELDS,
  batchProblems,
  compareAcceptance,
  localAcceptanceSettings,
  parseAcceptanceArgs,
  readDataset,
  stageFocusSample,
  syncTwice,
  verifyDatasetBytes,
} from './acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.local.yml');
const FIXTURE_BASE = path.join(ROOT, 'fixtures', 'focus-1.0-synthetic', 'base');
const CONTROL_TOTALS = path.join(ROOT, 'fixtures', 'focus-1.0-synthetic', 'control-totals.json');
const CONTROL_CALCULATOR = path.join(ROOT, 'scripts', 'acceptance', 'focus_control_totals.py');

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

// --- deadlines (every wait in this file; EVIDENCE §13) --------------------------

const DOCKER_PS_TIMEOUT_MS = 60_000;
/** `compose up -d --wait` (includes a first image pull in CI). */
const COMPOSE_UP_TIMEOUT_MS = 600_000;
const DOWN_TIMEOUT_MS = 300_000;
/** local:test's outer cut-off around `down -v` (the compose command's own timeout fires first). */
const CLEANUP_DOWN_TIMEOUT_MS = DOWN_TIMEOUT_MS + 30_000;
const WORKER_BUILD_TIMEOUT_MS = 300_000;
const WORKER_CLI_TIMEOUT_MS = 600_000;
const PG_CONNECT_TIMEOUT_MS = 5_000;
/** Client-side (query_timeout) and server-side (statement_timeout) per statement. */
const PG_QUERY_TIMEOUT_MS = 60_000;
/** A whole withClient session: connect, every statement, disconnect. */
const PG_SESSION_TIMEOUT_MS = 120_000;
const PG_END_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 120_000;
const READY_ATTEMPT_TIMEOUT_MS = 5_000;
const BUCKET_WARM_TIMEOUT_MS = 60_000;
const S3_REQUEST_TIMEOUT_MS = 30_000;
const APP_READY_TIMEOUT_MS = 60_000;
const APP_READY_ATTEMPT_TIMEOUT_MS = 5_000;
/** Each API read: longer than the route's own 10 s DB statement_timeout (readerPool.ts). */
const API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
/** local:acceptance: the independent control-total calculator (python3) on the pinned file. */
const CONTROL_CALCULATOR_TIMEOUT_MS = 120_000;
/** local:acceptance reads with the route's largest page size (query.ts: 1..500). */
const ACCEPTANCE_PAGE_LIMIT = 500;
/** Upstream-derived fields compared per row (UPSTREAM_COMPARED_FIELDS), recorded in the summary. */
const API_ROW_FIELDS_COMPARED = UPSTREAM_COMPARED_FIELDS.length;

// --- processes ---------------------------------------------------------------

/** The subcommand, and the interrupt that SIGINT/SIGTERM fires (see main). */
const COMMAND = process.argv[2];
const interrupt = new AbortController();

// Every command is bound to the interrupt (killed when it fires, never started
// after it), except `down`, which is the cleanup itself (signal: null).
function run(cmd, args, { env = {}, capture = false, allowFail = false, timeoutMs, signal = interrupt.signal } = {}) {
  return runProcess(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, capture, allowFail, timeoutMs, signal: signal ?? undefined });
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

/**
 * One Postgres session, hard-bounded: connect (PG_CONNECT_TIMEOUT_MS), every
 * statement (query_timeout client-side, statement_timeout server-side), the
 * disconnect, and the whole session (PG_SESSION_TIMEOUT_MS). When the session
 * deadline or the caller's signal fires, the socket is destroyed.
 */
function withClient(url, fn, { signal } = {}) {
  return withDeadline(
    async (deadlineSignal) => {
      const c = new Client({ connectionString: url, connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS, query_timeout: PG_QUERY_TIMEOUT_MS, statement_timeout: PG_QUERY_TIMEOUT_MS });
      c.on('error', () => undefined);
      const aborted = signal ? AbortSignal.any([deadlineSignal, signal]) : deadlineSignal;
      const kill = () => c.connection?.stream?.destroy();
      aborted.addEventListener('abort', kill, { once: true });
      try {
        await c.connect();
        try {
          return await fn(c);
        } finally {
          await withDeadline(() => c.end(), PG_END_TIMEOUT_MS, 'postgres disconnect').catch(kill);
        }
      } finally {
        aborted.removeEventListener('abort', kill);
      }
    },
    PG_SESSION_TIMEOUT_MS,
    'postgres session',
  );
}

const superUrl = (settings, secrets) =>
  connectionUrl({ user: 'postgres', password: secrets.RATIO_LOCAL_PG_SUPERUSER_PASSWORD, port: settings.pgPort, database: 'postgres' });

// --- commands ----------------------------------------------------------------

async function up(settings) {
  const secrets = loadSecrets(settings, { create: true });
  await compose(settings, secrets, ['up', '-d', '--wait', 'postgres', 's3'], { timeoutMs: COMPOSE_UP_TIMEOUT_MS });
  await waitUntil({
    what: 'postgres',
    timeoutMs: READY_TIMEOUT_MS,
    attemptTimeoutMs: READY_ATTEMPT_TIMEOUT_MS,
    probe: (signal) => withClient(superUrl(settings, secrets), async (c) => (await c.query('SELECT 1')).rowCount === 1, { signal }),
  });
  // Each attempt is aborted at READY_ATTEMPT_TIMEOUT_MS: an endpoint that
  // accepts TCP but never answers cannot hang local:up (Copilot 4176117539).
  await waitUntil({
    what: 's3',
    timeoutMs: READY_TIMEOUT_MS,
    attemptTimeoutMs: READY_ATTEMPT_TIMEOUT_MS,
    probe: async (signal) => {
      const r = await fetch(`http://127.0.0.1:${settings.s3Port}/`, { signal });
      await r.body?.cancel();
      return r.status < 500;
    },
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
  if (!fs.existsSync(path.join(ROOT, 'dist-worker', 'ingest', 'cli.js'))) await run('npm', ['run', '-s', 'worker:build'], { timeoutMs: WORKER_BUILD_TIMEOUT_MS });
  return run(process.execPath, [path.join(ROOT, 'dist-worker', 'ingest', 'cli.js'), ...args], { env: workerEnv(settings, secrets), capture: true, timeoutMs: WORKER_CLI_TIMEOUT_MS, ...opts });
}

async function migrate(settings) {
  const secrets = loadSecrets(settings, { create: false });
  await run('npm', ['run', '-s', 'worker:build'], { timeoutMs: WORKER_BUILD_TIMEOUT_MS });
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
    // Belt and braces: every send below also carries an abortSignal with a hard deadline.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: S3_REQUEST_TIMEOUT_MS },
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: secrets.RATIO_LOCAL_S3_ACCESS_KEY_ID, secretAccessKey: secrets.RATIO_LOCAL_S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const s3Commands = () => require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-s3'));

/** Creates (idempotent) and warms the source and evidence buckets. */
async function ensureBuckets(s3) {
  const { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand } = s3Commands();
  for (const Bucket of [LOCAL_NAMES.sourceBucket, LOCAL_NAMES.evidenceBucket]) {
    try {
      await withDeadline((signal) => s3.send(new CreateBucketCommand({ Bucket }), { abortSignal: signal }), S3_REQUEST_TIMEOUT_MS, `s3 create bucket ${Bucket}`);
    } catch (e) {
      if (e?.name !== 'BucketAlreadyOwnedByYou' && e?.name !== 'BucketAlreadyExists') throw e;
    }
    // A fresh SeaweedFS bucket answers 500 until its volumes are allocated:
    // warm it with a probe object so the worker's first evidence write does
    // not spend its bounded retries on that (seen locally: 2 retries).
    await waitUntil({
      what: `s3 bucket ${Bucket} writable`,
      timeoutMs: BUCKET_WARM_TIMEOUT_MS,
      attemptTimeoutMs: S3_REQUEST_TIMEOUT_MS,
      probe: async (signal) => {
        await s3.send(new PutObjectCommand({ Bucket, Key: '.ratio-local-warmup', Body: 'warmup' }), { abortSignal: signal });
        await s3.send(new DeleteObjectCommand({ Bucket, Key: '.ratio-local-warmup' }), { abortSignal: signal });
        return true;
      },
    });
  }
}

/** PUTs { Key, body() } objects into the source bucket, each under a hard deadline. */
async function putObjects(s3, objects) {
  const { PutObjectCommand } = s3Commands();
  for (const o of objects) {
    const Body = o.body();
    await withDeadline((signal) => s3.send(new PutObjectCommand({ Bucket: LOCAL_NAMES.sourceBucket, Key: o.Key, Body }), { abortSignal: signal }), S3_REQUEST_TIMEOUT_MS, `s3 put ${o.Key}`);
  }
}

/**
 * Provisions the local tenant and one focus_file source as the owner login
 * (ingestion-ops SKILL §2; RLS applies to the owner too). Idempotent.
 * Returns the source's id.
 */
async function provisionSource(settings, secrets, { tenantSlug, sourceKey, displayName, prefix, exportName }) {
  const migratorUrl = workerEnv(settings, secrets).RATIO_MIGRATE_DATABASE_URL;
  return withClient(migratorUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [secrets.RATIO_LOCAL_TENANT_ID]);
      await c.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [secrets.RATIO_LOCAL_TENANT_ID, tenantSlug]);
      await c.query(
        `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, config)
         VALUES ($1, gen_random_uuid(), $2, 'focus_file', $3, 'public_cloud', '1.0', $4::jsonb)
         ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [secrets.RATIO_LOCAL_TENANT_ID, sourceKey, displayName, JSON.stringify({ layout: 'aws-data-exports', bucket: LOCAL_NAMES.sourceBucket, prefix, exportName })],
      );
      const id = await c.query(`SELECT id::text AS id FROM ratio.sources WHERE tenant_id = $1 AND source_key = $2`, [secrets.RATIO_LOCAL_TENANT_ID, sourceKey]);
      const commit = await c.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('provisioning transaction was rolled back');
      if (id.rowCount !== 1) throw new Error(`source ${sourceKey} is not visible after provisioning`);
      return id.rows[0].id;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
}

async function seed(settings) {
  const secrets = loadSecrets(settings, { create: false });
  const s3 = s3Client(settings, secrets);
  try {
    await ensureBuckets(s3);
    const files = fixtureFiles(FIXTURE_BASE);
    await putObjects(
      s3,
      files.map((f) => ({ Key: path.relative(FIXTURE_BASE, f).split(path.sep).join('/'), body: () => fs.readFileSync(f) })),
    );
    log('seed: SYNTHETIC fixture uploaded', { bucket: LOCAL_NAMES.sourceBucket, objects: files.length });
  } finally {
    s3.destroy();
  }
  await provisionSource(settings, secrets, {
    tenantSlug: LOCAL_NAMES.tenantSlug,
    sourceKey: LOCAL_NAMES.sourceKey,
    displayName: 'SYNTHETIC local FOCUS fixture (not real data)',
    prefix: LOCAL_NAMES.fixturePrefix,
    exportName: LOCAL_NAMES.fixtureExportName,
  });
  log('seed: tenant and source provisioned', { tenant: secrets.RATIO_LOCAL_TENANT_ID, source: LOCAL_NAMES.sourceKey });
}

/**
 * One worker `sync` of a source; returns the exit code and the evidence record (stdout's last line).
 * allowFail: a failing sync's record (its outcomes and quarantine codes) must still be readable.
 * The exit code judged by every caller: sync() rejects r.code !== 0, syncTwice (acceptance.mjs) requires 0.
 */
async function syncRecord(settings, secrets, sourceKey) {
  const r = await workerCli(settings, secrets, ['sync', '--tenant', secrets.RATIO_LOCAL_TENANT_ID, '--source', sourceKey], { allowFail: true });
  process.stdout.write(r.out);
  let record = null;
  try {
    record = JSON.parse(r.out.trim().split('\n').pop());
  } catch {
    // no evidence record: judged by the caller
  }
  return { code: r.code, record };
}

async function sync(settings) {
  const secrets = loadSecrets(settings, { create: false });
  const r = await syncRecord(settings, secrets, LOCAL_NAMES.sourceKey);
  if (r.code !== 0) throw new Error(`worker sync exited ${r.code}`);
  if (r.record === null) throw new Error('worker sync printed no evidence record');
  return r.record;
}

async function down(settings, { volumes, timeoutMs }) {
  // Compose interpolates the whole file even for `down`: give it the real or a placeholder password.
  const file = envFileOf(settings);
  const secrets = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : { RATIO_LOCAL_PG_SUPERUSER_PASSWORD: 'unused-for-down' };
  await compose(settings, secrets, ['--profile', 'app', '--profile', 'worker', 'down', '--remove-orphans', ...(volumes ? ['-v'] : [])], { timeoutMs, signal: null });
  if (volumes) removeProjectState(ROOT, settings.project);
  log(volumes ? 'down: containers, network, volumes and local secrets removed' : 'down: containers and network removed (volumes kept)', { project: settings.project });
}


// --- end to end ----------------------------------------------------------------

/**
 * local:test and local:acceptance own their stack end to end (down -v at the
 * end), so before changing anything they refuse existing state, existing
 * containers of the project or a busy port.
 */
async function preflight(settings, what) {
  const containers = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${settings.project}`], { capture: true, timeoutMs: DOCKER_PS_TIMEOUT_MS })).out
    .split('\n')
    .filter(Boolean).length;
  const busyPorts = [];
  for (const p of [settings.pgPort, settings.s3Port, settings.appPort]) if (await portInUse(p)) busyPorts.push(p);
  const problems = preflightProblems({ stateExists: fs.existsSync(path.join(ROOT, localStatePaths(settings.project).dir)), containers, busyPorts });
  if (problems.length) throw new Error(`${what} refuses to start (nothing was changed):\n  ${problems.join('\n  ')}`);
}

/** Spawns `next start` (reader URL, token, tenant binding) in its own tracked group and waits until it is ours and ready. */
async function startAppAndWait(settings, secrets, { setApp, spawnGuard }) {
  const base = `http://127.0.0.1:${settings.appPort}`;
  // Re-check the app port right before spawning (minutes after the preflight).
  const app = await startIfPortFree({
    port: settings.appPort,
    // Its own process group, tracked with the commands: a forced exit
    // (second signal) kills it too, never leaving an orphan next start.
    // Refused once the cleanup has started (an interrupt during the port re-check).
    start: spawnGuard(() =>
      trackProcessGroup(
        spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(settings.appPort), '-H', '127.0.0.1'], {
          cwd: ROOT,
          env: { ...process.env, ...apiEnv(settings, secrets), NODE_ENV: 'production' },
          stdio: ['ignore', 'ignore', 'inherit'],
          detached: true,
        }),
      ),
    ),
  });
  setApp(app);
  return waitForOwnServer({
    child: app,
    port: settings.appPort,
    timeoutMs: APP_READY_TIMEOUT_MS,
    attemptTimeoutMs: APP_READY_ATTEMPT_TIMEOUT_MS,
    probe: async (signal) => {
      const r = await fetch(`${base}/api/hello`, { signal });
      await r.body?.cancel();
      return r.status === 200;
    },
  });
}

/** Pages GET /api/v1/costs/published until nextCursor is null; every read bounded. Page 1 carries the totals. */
async function readPublished(base, token, { limit, maxPages }) {
  const rows = [];
  let totals = null;
  let cursor = null;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const r = await fetchJson(`${base}/api/v1/costs/published?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, { token, timeoutMs: API_REQUEST_TIMEOUT_MS });
    if (r.status !== 200) throw new Error(`API read answered ${r.status}: ${JSON.stringify(r.body)}`);
    if (page === 0) totals = r.body.totals;
    rows.push(...r.body.data);
    pages += 1;
    cursor = r.body.page.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error(`more than ${maxPages} pages`);
  return { rows, totals, pages };
}

async function localTest() {
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no Next.js build: run `npm run build` first');
  // local:test owns its stack end to end (down -v at the end), so it uses its
  // OWN project and ports and refuses to start over anything already there.
  const settings = localTestSettings(process.env);
  await preflight(settings, 'local:test');

  // runLocalTest runs the body, then ALWAYS the bounded cleanup (stop the app,
  // `down -v`), then decides pass/fail in one pure function
  // (finalizeLocalTestSummary): a failed body, an app that could not be
  // stopped cleanly, or a failed `down -v` each fail the run.
  const summary = await runLocalTest({
    project: settings.project,
    down: () => down(settings, { volumes: true, timeoutMs: DOWN_TIMEOUT_MS }),
    downTimeoutMs: CLEANUP_DOWN_TIMEOUT_MS,
    // SIGINT/SIGTERM abort this: the body ends, then the same cleanup runs.
    signal: interrupt.signal,
    body: async ({ steps, setApp, spawnGuard }) => {
      await up(settings);
      await up(settings); // idempotent
      steps.up = 'ok (twice)';
      const status = await migrate(settings);
      await migrate(settings); // idempotent
      steps.migrate = { currentVersion: status.currentVersion, privilegeProblems: status.privilegeProblems };
      await seed(settings);
      await seed(settings); // idempotent
      steps.seed = 'ok (twice)';
      const first = await sync(settings);
      const outcomes = (rec) => Object.fromEntries((rec.results?.periods ?? []).map((p) => [p.billingPeriod, p.outcome]));
      steps.sync = outcomes(first);
      const second = await sync(settings);
      steps.syncAgain = outcomes(second);
      if (Object.values(steps.sync).some((o) => o !== 'published')) throw new Error(`first sync did not publish every period: ${JSON.stringify(steps.sync)}`);
      if (Object.values(steps.syncAgain).some((o) => o !== 'skipped_unchanged')) throw new Error(`second sync was not a no-op: ${JSON.stringify(steps.syncAgain)}`);

      const secrets = loadSecrets(settings, { create: false });
      const base = `http://127.0.0.1:${settings.appPort}`;
      steps.appReady = await startAppAndWait(settings, secrets, { setApp, spawnGuard });

      // Every API read is bounded (Copilot 4176117553): a next start that is
      // alive but stuck fails the run instead of blocking the cleanup.
      const anon = await fetchJson(`${base}/api/v1/costs/published`, { timeoutMs: API_REQUEST_TIMEOUT_MS });
      if (anon.status !== 401) throw new Error(`anonymous read answered ${anon.status}, expected 401`);
      steps.anonymous = anon.status;

      const { rows, totals } = await readPublished(base, secrets.RATIO_LOCAL_API_TOKEN, { limit: 17, maxPages: MAX_PAGES });
      const control = JSON.parse(fs.readFileSync(CONTROL_TOTALS, 'utf8')).base;
      const mismatches = compareControlTotals(totals ?? [], control);
      const keys = new Set(rows.map((r) => `${r.batchId}/${r.artifactSha256}/${r.rowOrdinal}`));
      const expectedRows = Object.values(control).reduce((n, c) => n + c.rowCount, 0);
      if (rows.length !== expectedRows || keys.size !== expectedRows) mismatches.push(`rows over all pages: ${rows.length} (${keys.size} distinct), expected ${expectedRows}`);
      if (rows.some((r) => typeof r.billedCost !== 'string')) mismatches.push('a billedCost is not a decimal string');
      steps.api = { totals, rows: rows.length, distinct: keys.size };
      if (mismatches.length) throw new Error(`reader totals differ from the fixture control totals:\n  ${mismatches.join('\n  ')}`);
    },
  });
  // Safety net: nothing local:test started may outlive it (e.g. a command the
  // interrupted body was still starting while the cleanup ran).
  killLiveProcessGroups();
  process.stdout.write(`${JSON.stringify({ type: 'ratio.local-test', ...summary })}\n`);
  if (!summary.pass) log('local:test failed', { failures: summary.failures });
  return localTestExitCode(summary);
}

// --- acceptance on the public FOCUS 1.0 Sample Data (Slice 2b) -------------------
//
// docs/evidence/slice-2b/DESIGN.md §5. The pinned sample file, staged as an AWS
// Data Exports layout in this run's own SeaweedFS, goes through the REAL worker
// CLI (sync ×2) and the REAL route under next start. The result must equal
// control totals computed independently (Python) from the upstream file.

/**
 * Re-hashes the evidence object of every staged data object
 * (`evidence/<tenant>/<source>/<sha256>`, Slice 1 D6). Each must hash to its
 * key and to the staged bytes' SHA-256.
 */
async function rehashEvidence(settings, secrets, sourceId, shas) {
  const { GetObjectCommand } = s3Commands();
  const s3 = s3Client(settings, secrets);
  const results = [];
  try {
    for (const sha of shas) {
      const Key = `evidence/${secrets.RATIO_LOCAL_TENANT_ID}/${sourceId}/${sha}`;
      const bytes = await withDeadline(
        async (signal) => {
          const r = await s3.send(new GetObjectCommand({ Bucket: LOCAL_NAMES.evidenceBucket, Key }), { abortSignal: signal });
          return Buffer.from(await r.Body.transformToByteArray());
        },
        S3_REQUEST_TIMEOUT_MS,
        `s3 get evidence ${sha.slice(0, 12)}`,
      );
      results.push({ sha256: sha, rehash: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  } finally {
    s3.destroy();
  }
  return results;
}

/**
 * Catalog check as the local superuser, in a READ ONLY transaction: the
 * sample tenant's batches, and the average stored fact size for D-09
 * (informational).
 */
async function catalogSnapshot(settings, secrets) {
  const url = connectionUrl({ user: 'postgres', password: secrets.RATIO_LOCAL_PG_SUPERUSER_PASSWORD, port: settings.pgPort, database: LOCAL_NAMES.database });
  return withClient(url, async (c) => {
    await c.query('BEGIN TRANSACTION READ ONLY');
    try {
      const batches = await c.query(
        `SELECT to_char(billing_period, 'YYYY-MM-DD') AS billing_period, status, reconciliation, is_provisional,
                row_count::text AS row_count, loaded_billed_total::text AS loaded_billed_total,
                validation_error_count::text AS validation_error_count, quarantine_reason
           FROM ratio.ingest_batches WHERE tenant_id = $1 ORDER BY billing_period, status`,
        [secrets.RATIO_LOCAL_TENANT_ID],
      );
      const facts = await c.query(
        `SELECT count(*)::text AS rows, round(avg(pg_column_size(f.*)), 1)::text AS avg_row_bytes,
                round(avg(pg_column_size(f.extra_columns)), 1)::text AS avg_extra_columns_bytes
           FROM ratio.cost_facts f WHERE tenant_id = $1`,
        [secrets.RATIO_LOCAL_TENANT_ID],
      );
      return { batches: batches.rows, facts: facts.rows[0] };
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/** Steps' wall time in ms, kept in the summary even when a step throws. */
function timer(steps) {
  steps.timingsMs = {};
  return async (name, fn) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      steps.timingsMs[name] = Date.now() - t0;
    }
  };
}

const fail = (what, problems) => {
  if (problems.length) throw new Error(`${what}:\n  ${problems.join('\n  ')}`);
};

async function acceptance(args) {
  const started = Date.now();
  const opts = parseAcceptanceArgs(args);
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no Next.js build: run `npm run build` first');
  const settings = localAcceptanceSettings(process.env);

  // 1. Before anything starts: the pinned file, the independent control, the staging.
  const dataset = readDataset(ROOT);
  const pin = dataset.files[opts.dataset];
  const file = path.join(ROOT, pin.localPath);
  if (!fs.existsSync(file)) throw new Error(`${pin.localPath} is missing: run \`npm run sample:fetch\` first (pinned download, SHA-256 checked)`);
  const bytes = fs.readFileSync(file);
  fail(`dataset ${opts.dataset} (${pin.localPath}) does not match dataset.json; re-run \`npm run sample:fetch\``, verifyDatasetBytes(bytes, pin));

  const calcStarted = Date.now();
  const calc = await run('python3', [CONTROL_CALCULATOR, '--rows', '--expect-sha256', pin.sha256, file], { capture: true, allowFail: true, timeoutMs: CONTROL_CALCULATOR_TIMEOUT_MS });
  if (calc.code !== 0) throw new Error(`the control-total calculator exited ${calc.code}`);
  const control = JSON.parse(calc.out);
  const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, SAMPLE_CONTROL_TOTALS_FILE), 'utf8'))[opts.dataset];
  if (JSON.stringify({ input: control.input, columns: control.columns, totals: control.totals }) !== JSON.stringify(pinned)) {
    throw new Error(`the calculator's output differs from the pinned ${SAMPLE_CONTROL_TOTALS_FILE} (${opts.dataset})`);
  }
  const calcMs = Date.now() - calcStarted;

  const stageStarted = Date.now();
  const staged = stageFocusSample(bytes, { mutation: opts.mutation }); // proves the clean plan lossless first
  const stageMs = Date.now() - stageStarted;
  const dataShas = staged.objects.filter((o) => o.kind === 'data').map((o) => o.sha256);
  const totalRows = control.totals.reduce((n, t) => n + Number(t.rowCount), 0);

  await preflight(settings, 'local:acceptance');

  const summary = await runLocalTest({
    project: settings.project,
    down: () => down(settings, { volumes: true, timeoutMs: DOWN_TIMEOUT_MS }),
    downTimeoutMs: CLEANUP_DOWN_TIMEOUT_MS,
    signal: interrupt.signal,
    body: async ({ steps, setApp, spawnGuard }) => {
      const timed = timer(steps);
      steps.timingsMs.controlTotals = calcMs;
      steps.timingsMs.stage = stageMs;
      steps.dataset = { key: opts.dataset, file: pin.localPath, bytes: pin.bytes, sha256: pin.sha256, commit: dataset.commit, licence: dataset.licence };
      steps.mutation = opts.mutation;
      steps.control = control.totals;
      steps.staging = { periods: staged.periods, objects: staged.objects.map((o) => ({ key: o.key, bytes: o.body.length, sha256: o.sha256 })), nullTokensReplaced: staged.nullTokensReplaced };

      await timed('up', () => up(settings));
      const status = await timed('migrate', () => migrate(settings));
      steps.migrate = { currentVersion: status.currentVersion, privilegeProblems: status.privilegeProblems };
      const secrets = loadSecrets(settings, { create: false });

      // Stage into the run's own SeaweedFS, then provision the sample source.
      const sourceId = await timed('seed', async () => {
        const s3 = s3Client(settings, secrets);
        try {
          await ensureBuckets(s3);
          await putObjects(
            s3,
            staged.objects.map((o) => ({ Key: o.key, body: () => o.body })),
          );
        } finally {
          s3.destroy();
        }
        return provisionSource(settings, secrets, SAMPLE_NAMES);
      });
      steps.seed = { objects: staged.objects.length, source: SAMPLE_NAMES.sourceKey };

      // The real worker CLI, twice, judged on its exit code AND its evidence
      // record (syncTwice; Copilot 4177490229 / 4177490261).
      const outcomes = (rec) => (rec?.results?.periods ?? []).map((p) => ({ period: p.billingPeriod, outcome: p.outcome, code: p.code, rowCount: p.rowCount, billedTotal: p.billedTotal, reconciliation: p.reconciliation }));
      await syncTwice({
        control,
        sync: (name) => timed(name, () => syncRecord(settings, secrets, SAMPLE_NAMES.sourceKey)),
        report: (name, r) => {
          steps[name] = { exit: r.code, ...(name === 'sync' ? { durationMs: r.record?.durationMs } : {}), periods: outcomes(r.record) };
        },
        // Diagnostics before failing: the batches' quarantine reasons (codes and counts, never cell values).
        beforeFail: async () => {
          steps.catalog = await catalogSnapshot(settings, secrets).catch((e) => ({ error: e.message }));
        },
      });
      // The real route under next start.
      steps.appReady = await timed('appStart', () => startAppAndWait(settings, secrets, { setApp, spawnGuard }));
      const base = `http://127.0.0.1:${settings.appPort}`;
      const anon = await fetchJson(`${base}/api/v1/costs/published`, { timeoutMs: API_REQUEST_TIMEOUT_MS });
      if (anon.status !== 401) throw new Error(`anonymous read answered ${anon.status}, expected 401`);
      steps.anonymous = anon.status;
      const maxPages = Math.ceil(totalRows / ACCEPTANCE_PAGE_LIMIT) + 1;
      const { rows, totals, pages } = await timed('apiRead', () => readPublished(base, secrets.RATIO_LOCAL_API_TOKEN, { limit: ACCEPTANCE_PAGE_LIMIT, maxPages }));
      steps.api = { totals, rows: rows.length, pages, limit: ACCEPTANCE_PAGE_LIMIT };
      fail('the API read differs from the independent control totals', [...compareAcceptance({ control, apiTotals: totals, rows }), ...artifactSetProblems(rows, dataShas)]);
      // Every API row against its UPSTREAM record (the calculator's --rows), every field (challenger M1).
      fail('the API rows differ from the upstream records (full-row comparison, keyed by Id)', rowProblems(rows, control));
      steps.rowsCompared = { rows: control.rows.length, fieldsPerRow: API_ROW_FIELDS_COMPARED, extraColumns: control.columns.extra.length };

      // Evidence re-hash and the catalog.
      const rehash = await timed('evidenceRehash', () => rehashEvidence(settings, secrets, sourceId, dataShas));
      steps.evidence = rehash;
      fail('evidence re-hash', rehash.filter((r) => r.rehash !== r.sha256).map((r) => `evidence ${r.sha256} re-hashes to ${r.rehash}`));
      const catalog = await timed('catalog', () => catalogSnapshot(settings, secrets));
      steps.catalog = catalog;
      fail('catalog', batchProblems(catalog.batches, control));
    },
  });
  killLiveProcessGroups();
  summary.steps.timingsMs = { ...(summary.steps.timingsMs ?? {}), total: Date.now() - started };
  process.stdout.write(`${JSON.stringify({ type: 'ratio.local-acceptance', dataset: opts.dataset, mutation: opts.mutation, ...summary })}\n`);
  if (!summary.pass) log('local:acceptance failed', { mutation: opts.mutation, failures: summary.failures });
  return localTestExitCode(summary);
}

// --- main ----------------------------------------------------------------------

const done = (p) => p.then(() => 0);
const COMMANDS = {
  up: (s) => done(up(s)),
  migrate: (s) => done(migrate(s)),
  seed: (s) => done(seed(s)),
  sync: (s) => done(sync(s)),
  down: (s, args) => done(down(s, { volumes: args.includes('-v') || args.includes('--volumes'), timeoutMs: DOWN_TIMEOUT_MS })),
  test: () => localTest(),
  acceptance: (_s, args) => acceptance(args),
};

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!COMMANDS[cmd]) {
    process.stderr.write(`usage: node scripts/local/local.mjs <${Object.keys(COMMANDS).join('|')}> [-v]\n`);
    return 2;
  }
  return (await COMMANDS[cmd](localSettings(process.env), args)) ?? 0;
}

// SIGINT / SIGTERM. Every command (and next start) runs in its own detached
// process group, so a Ctrl-C to this script does not reach them by itself.
// - local:test and local:acceptance (built on the same runLocalTest): the
//   first signal aborts the run, which then goes through the SAME bounded
//   cleanup (stop next start, `down -v`) and exits 130/143.
// - every other command (up, migrate, seed, sync, down): kill the live groups
//   and exit 130/143 at once; whatever already exists (containers, volumes,
//   .ratio-local/<project>/) stays for `npm run local:down [-- -v]`.
// - a second signal forces an immediate exit (groups killed, cleanup skipped).
installInterruptHandlers({
  onFirst: (sig) => {
    if (COMMAND === 'test' || COMMAND === 'acceptance') {
      log('interrupted: ending the run, then the normal cleanup', { signal: sig });
      interrupt.abort(sig);
      return;
    }
    killLiveProcessGroups();
    log('interrupted: child processes killed; use local:down to clean up', { signal: sig });
    process.exit(exitCodeForSignal(sig));
  },
  onForce: (sig) => {
    killLiveProcessGroups();
    log('second signal: forced exit, cleanup skipped', { signal: sig });
    process.exit(exitCodeForSignal(sig));
  },
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    log('failed', { error: e.message });
    process.exit(1);
  },
);
