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
//
// Every child process, network call and wait below has a HARD deadline (the
// *_TIMEOUT_MS constants; the full inventory is in
// docs/evidence/slice-2/EVIDENCE.md §13): nothing here can hang `local:up`,
// and local:test always reaches its `down -v`.
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

async function seed(settings) {
  const secrets = loadSecrets(settings, { create: false });
  const { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand } = require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-s3'));
  const s3 = s3Client(settings, secrets);
  try {
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
    const files = fixtureFiles(FIXTURE_BASE);
    for (const f of files) {
      const Key = path.relative(FIXTURE_BASE, f).split(path.sep).join('/');
      const Body = fs.readFileSync(f);
      await withDeadline((signal) => s3.send(new PutObjectCommand({ Bucket: LOCAL_NAMES.sourceBucket, Key, Body }), { abortSignal: signal }), S3_REQUEST_TIMEOUT_MS, `s3 put ${Key}`);
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

async function down(settings, { volumes, timeoutMs }) {
  // Compose interpolates the whole file even for `down`: give it the real or a placeholder password.
  const file = envFileOf(settings);
  const secrets = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : { RATIO_LOCAL_PG_SUPERUSER_PASSWORD: 'unused-for-down' };
  await compose(settings, secrets, ['--profile', 'app', '--profile', 'worker', 'down', '--remove-orphans', ...(volumes ? ['-v'] : [])], { timeoutMs, signal: null });
  if (volumes) removeProjectState(ROOT, settings.project);
  log(volumes ? 'down: containers, network, volumes and local secrets removed' : 'down: containers and network removed (volumes kept)', { project: settings.project });
}


// --- end to end ----------------------------------------------------------------

async function localTest() {
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no Next.js build: run `npm run build` first');
  // local:test owns its stack end to end (down -v at the end), so it uses its
  // OWN project and ports and refuses to start over anything already there.
  const settings = localTestSettings(process.env);
  const containers = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${settings.project}`], { capture: true, timeoutMs: DOCKER_PS_TIMEOUT_MS })).out
    .split('\n')
    .filter(Boolean).length;
  const busyPorts = [];
  for (const p of [settings.pgPort, settings.s3Port, settings.appPort]) if (await portInUse(p)) busyPorts.push(p);
  const problems = preflightProblems({ stateExists: fs.existsSync(path.join(ROOT, localStatePaths(settings.project).dir)), containers, busyPorts });
  if (problems.length) throw new Error(`local:test refuses to start (nothing was changed):\n  ${problems.join('\n  ')}`);

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
      steps.appReady = await waitForOwnServer({
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

      // Every API read is bounded (Copilot 4176117553): a next start that is
      // alive but stuck fails the run instead of blocking the cleanup.
      const anon = await fetchJson(`${base}/api/v1/costs/published`, { timeoutMs: API_REQUEST_TIMEOUT_MS });
      if (anon.status !== 401) throw new Error(`anonymous read answered ${anon.status}, expected 401`);
      steps.anonymous = anon.status;

      const rows = [];
      let totals = null;
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const r = await fetchJson(`${base}/api/v1/costs/published?limit=17${cursor ? `&cursor=${cursor}` : ''}`, { token: secrets.RATIO_LOCAL_API_TOKEN, timeoutMs: API_REQUEST_TIMEOUT_MS });
        if (r.status !== 200) throw new Error(`API read answered ${r.status}: ${JSON.stringify(r.body)}`);
        if (page === 0) totals = r.body.totals;
        rows.push(...r.body.data);
        cursor = r.body.page.nextCursor;
        if (!cursor) break;
      }
      if (cursor) throw new Error(`more than ${MAX_PAGES} pages`);
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

// --- main ----------------------------------------------------------------------

const done = (p) => p.then(() => 0);
const COMMANDS = {
  up: (s) => done(up(s)),
  migrate: (s) => done(migrate(s)),
  seed: (s) => done(seed(s)),
  sync: (s) => done(sync(s)),
  down: (s, args) => done(down(s, { volumes: args.includes('-v') || args.includes('--volumes'), timeoutMs: DOWN_TIMEOUT_MS })),
  test: () => localTest(),
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
// - local:test: the first signal aborts the run, which then goes through the
//   SAME bounded cleanup (stop next start, `down -v`) and exits 130/143.
// - every other command (up, migrate, seed, sync, down): kill the live groups
//   and exit 130/143 at once; whatever already exists (containers, volumes,
//   .ratio-local/<project>/) stays for `npm run local:down [-- -v]`.
// - a second signal forces an immediate exit (groups killed, cleanup skipped).
installInterruptHandlers({
  onFirst: (sig) => {
    if (COMMAND === 'test') {
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
