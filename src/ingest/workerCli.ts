// Worker commands of the CLI. Every command prints exactly ONE evidence record
// (JSON) on stdout — also on usage/config errors — and structured JSON logs on
// stderr. Everything printed is redacted; row contents are never logged.
//
//   sync            --tenant <uuid> --source <key>
//   backfill        --tenant <uuid> --source <key> --from YYYY-MM --to YYYY-MM
//   replay          --tenant <uuid> --source <key> (--batch <uuid> | --period YYYY-MM)
//   quarantine show --tenant <uuid> --batch <uuid> [--json]
//   doctor          [--tenant <uuid>]... [--json]          (read-only)
//   replay-fixtures [--json]                               (RATIO_ENV staging|test only)
//
// Exit codes: 0 ok · 1 failure · 2 usage/configuration · 4 another run holds the lease.
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import type { CliIO } from './cli';
import { loadWorkerConfig, type WorkerConfig } from './config';
import { SYNTHETIC_PROVIDERS } from './focus/provider';
import { IngestError, errorCodeOf, messageOf } from './errors';
import { appendEvidenceFile, buildEvidenceRecord, resolveGitSha } from './evidenceRecord';
import { jsonLineRedactorFor, redact, secretsFromEnv } from './redact';
import { isTenantId } from './db/tenant';
import { makeS3Client } from './s3client';
import { S3EvidenceStore } from './evidence/S3EvidenceStore';
import { assertSafeWorkerRole, createWorkerPool } from './worker/db';
import { runSync, type RunMode } from './worker/pipeline';
import { replayBatch } from './worker/replay';
import { showBatch } from './worker/quarantine';
import { runDoctor } from './worker/doctor';
import { runReplayFixtures } from './worker/replayFixtures';
import { makeSourceFactory } from './worker/sourceFactory';
import type { WorkerHooks } from './worker/types';
import { MIN_PERIOD_YEAR } from './worker/periods';

type Env = Record<string, string | undefined>;

const WORKER_COMMANDS = new Set(['sync', 'backfill', 'replay', 'quarantine', 'doctor', 'replay-fixtures']);
export function isWorkerCommand(c: string | undefined): boolean {
  return c !== undefined && WORKER_COMMANDS.has(c);
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_BUSY = 4;
const USAGE_CODES = new Set(['USAGE', 'CONFIG_INVALID', 'INVALID_TENANT', 'TEST_HOOK_NOT_ALLOWED', 'REPLAY_FIXTURES_NOT_ALLOWED', 'INVALID_SOURCE_KEY', 'INVALID_RANGE', 'INVALID_BATCH']);

function exitCodeFor(code: string): number {
  if (code === 'ALREADY_RUNNING' || code === 'LOCK_TIMEOUT') return EXIT_BUSY;
  if (USAGE_CODES.has(code)) return EXIT_USAGE;
  return EXIT_FAIL;
}

interface Args {
  command: string;
  tenants: string[];
  source?: string;
  from?: string;
  to?: string;
  batch?: string;
  period?: string;
  json: boolean;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function usage(message: string): never {
  throw new IngestError('USAGE', message);
}

function parseArgs(argv: string[]): Args {
  let [command, ...rest] = argv;
  if (command === 'quarantine') {
    if (rest[0] !== 'show') usage('usage: quarantine show --tenant <uuid> --batch <uuid> [--json]');
    command = 'quarantine show';
    rest = rest.slice(1);
  }
  const a: Args = { command, tenants: [], json: false };
  const allowed: Record<string, string[]> = {
    sync: ['--tenant', '--source', '--json'],
    backfill: ['--tenant', '--source', '--from', '--to', '--json'],
    replay: ['--tenant', '--source', '--batch', '--period', '--json'],
    'quarantine show': ['--tenant', '--batch', '--json'],
    doctor: ['--tenant', '--json'],
    'replay-fixtures': ['--json'],
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed[command].includes(flag)) usage(`unknown or unsupported argument for ${command}: ${flag.slice(0, 40)}`);
    if (flag === '--json') {
      a.json = true;
      continue;
    }
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) usage(`${flag} needs a value`);
    if (flag === '--tenant') {
      if (!isTenantId(v)) usage('--tenant must be a UUID');
      a.tenants.push(v.toLowerCase());
    } else if (flag === '--source') {
      if (!SOURCE_KEY_RE.test(v)) usage('--source must be a source key ([a-z0-9][a-z0-9_-]*)');
      a.source = v;
    } else if (flag === '--from' || flag === '--to' || flag === '--period') {
      if (!MONTH_RE.test(v)) usage(`${flag} must be YYYY-MM`);
      if (Number(v.slice(0, 4)) < MIN_PERIOD_YEAR) usage(`${flag} must lie within ${MIN_PERIOD_YEAR}-01..9999-12`);
      a[flag.slice(2) as 'from' | 'to' | 'period'] = `${v}-01`;
    } else if (flag === '--batch') {
      if (!isTenantId(v)) usage('--batch must be a UUID');
      a.batch = v.toLowerCase();
    }
  }
  const needs = (cond: boolean, m: string) => {
    if (!cond) usage(m);
  };
  if (command !== 'doctor' && command !== 'replay-fixtures') needs(a.tenants.length === 1, '--tenant <uuid> is required exactly once');
  if (['sync', 'backfill', 'replay'].includes(command)) needs(!!a.source, '--source <key> is required');
  if (command === 'backfill') {
    needs(!!a.from && !!a.to, '--from and --to are required');
    needs(a.from! <= a.to!, '--from must not be after --to');
  }
  if (command === 'replay') needs(!!a.batch !== !!a.period, 'replay needs exactly one of --batch or --period');
  if (command === 'quarantine show') needs(!!a.batch, '--batch <uuid> is required');
  return a;
}

function argsForRecord(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 1; i < argv.length; i++) {
    const f = argv[i];
    if (!f.startsWith('--')) continue;
    const key = f.slice(2);
    if (key === 'json') out.json = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = String(argv[++i]).slice(0, 80);
  }
  return out;
}

export async function workerMain(argv: string[], env: Env, io: CliIO): Promise<number> {
  const started = new Date();
  const secrets = secretsFromEnv(env);
  // Every printed line is redacted BEFORE serialization (then a literal backstop).
  const line = jsonLineRedactorFor(env);
  const clean = (s: string) => redact(s, secrets);
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    io.err(line({ ts: new Date().toISOString(), level: event.endsWith('failed') || event === 'cli.error' || fields.status === 'fail' ? 'error' : 'info', event, ...fields }));
  };
  const command = argv[0] === 'quarantine' ? 'quarantine show' : argv[0];
  let config: WorkerConfig | null = null;
  const finish = (results: Record<string, unknown>, pass: boolean, exitCode: number): number => {
    const record = buildEvidenceRecord({
      command,
      args: argsForRecord(argv),
      gitSha: resolveGitSha(env),
      artifactDigest: config?.artifactDigest ?? null,
      startedAt: started,
      finishedAt: new Date(),
      results,
      pass,
      exitCode,
      secrets,
    });
    io.out(line(record));
    appendEvidenceFile(config?.evidenceFile ?? env.RATIO_EVIDENCE_FILE, record, line);
    return exitCode;
  };
  const fail = (e: unknown): number => {
    const code = errorCodeOf(e);
    const message = clean(messageOf(e)).slice(0, 1000);
    log('cli.error', { code, message });
    return finish({ error: { code, message } }, false, exitCodeFor(code));
  };

  let args: Args;
  try {
    args = parseArgs(argv);
    if (args.command === 'replay-fixtures' && env.RATIO_ENV !== 'staging' && env.RATIO_ENV !== 'test') {
      throw new IngestError('REPLAY_FIXTURES_NOT_ALLOWED', 'replay-fixtures runs only when RATIO_ENV is staging or test');
    }
    config = loadWorkerConfig(env);
  } catch (e) {
    return fail(e);
  }
  const cfg = config;
  if (cfg.settings.allowSyntheticProviders) {
    // Logged once per process start (issue #62 D1): synthetic provider names are accepted.
    // Counts only: provider names are row values, and logs never carry row values (Slice 1 K1).
    log('config.synthetic_providers_allowed', { level: 'warn', syntheticProviderCount: SYNTHETIC_PROVIDERS.length, detail: 'RATIO_ALLOW_SYNTHETIC_PROVIDERS=1: the fixed synthetic provider set (focus/provider.ts) is accepted; never set this for real billing data' });
  }

  if (args.command === 'doctor') {
    try {
      const r = await runDoctor({
        workerUrl: cfg.databaseUrl,
        migrateUrl: cfg.migrateDatabaseUrl,
        tenantIds: args.tenants,
        maxStalenessHours: cfg.doctorMaxStalenessHours,
        firstPublishGraceHours: cfg.doctorFirstPublishGraceHours,
        secrets,
      });
      for (const c of r.checks) log('doctor.check', { name: c.name, status: c.status, detail: c.detail ?? null });
      return finish({ checks: r.checks }, r.pass, r.pass ? EXIT_OK : EXIT_FAIL);
    } catch (e) {
      return fail(e);
    }
  }

  if (!cfg.databaseUrl) return fail(new IngestError('CONFIG_INVALID', 'RATIO_DATABASE_URL is not set'));
  // Clients are constructed inside the try below, so a constructor failure is a
  // reported (redacted) failure, never a throw out of main.
  let pool: Pool | undefined;
  const clients: S3Client[] = [];
  const s3 = (which: 'source' | 'evidence') => {
    const c = makeS3Client(which === 'source' ? cfg.sourceS3 : cfg.evidenceS3);
    clients.push(c);
    return c;
  };
  const evidenceStore = () => {
    if (!cfg.evidenceS3.bucket) throw new IngestError('CONFIG_INVALID', 'RATIO_EVIDENCE_S3_BUCKET is not set');
    return new S3EvidenceStore({ client: s3('evidence'), bucket: cfg.evidenceS3.bucket, prefix: cfg.evidenceS3.prefix });
  };
  const hooks: WorkerHooks = {};
  if (cfg.testPauseAfterRows !== null) {
    // Test-only (config guarantees NODE_ENV=test): signal and hang so a test can SIGKILL us mid-load.
    const threshold = cfg.testPauseAfterRows;
    let paused = false;
    hooks.afterChunk = async (info) => {
      if (paused || info.rowsInserted < threshold) return;
      paused = true;
      io.err(line({ ts: new Date().toISOString(), level: 'info', event: 'test.paused', runId: info.runId, batchId: info.batchId, rowsInserted: info.rowsInserted }));
      setInterval(() => undefined, 1 << 30);
      await new Promise<never>(() => undefined);
    };
  }

  try {
    pool = createWorkerPool(cfg.databaseUrl, { max: 4, ...cfg.db });
    await assertSafeWorkerRole(pool);
    const tenantId = args.tenants[0];
    switch (args.command) {
      case 'sync':
      case 'backfill':
      case 'replay': {
        if (args.command === 'replay' && args.batch) {
          const r = await replayBatch({ pool, tenantId, sourceKey: args.source!, batchId: args.batch, settings: cfg.settings, hooks, log });
          return finish({ ...r }, true, EXIT_OK);
        }
        const mode: RunMode = args.command === 'sync' ? 'sync' : args.command === 'backfill' ? 'backfill' : 'replay_period';
        const range = args.command === 'backfill' ? { from: args.from!, to: args.to! } : args.command === 'replay' ? { from: args.period!, to: args.period! } : undefined;
        const r = await runSync({
          pool,
          tenantId,
          sourceKey: args.source!,
          source: makeSourceFactory(env, () => s3('source')),
          evidence: evidenceStore(),
          mode,
          range,
          settings: cfg.settings,
          hooks,
          log,
          secrets,
        });
        const ok = r.status === 'succeeded';
        return finish({ ...r }, ok, ok ? EXIT_OK : EXIT_FAIL);
      }
      case 'quarantine show': {
        const r = await showBatch(pool, tenantId, args.batch!);
        return finish({ ...r }, true, EXIT_OK);
      }
      case 'replay-fixtures': {
        if (!cfg.migrateDatabaseUrl) throw new IngestError('CONFIG_INVALID', 'RATIO_MIGRATE_DATABASE_URL is required to create and delete the fixture tenant');
        if (!cfg.replayFixturesBucket) throw new IngestError('CONFIG_INVALID', 'RATIO_REPLAY_FIXTURES_BUCKET is not set');
        const r = await runReplayFixtures({
          workerPool: pool,
          adminUrl: cfg.migrateDatabaseUrl,
          sourceClient: s3('source'),
          bucket: cfg.replayFixturesBucket,
          evidence: evidenceStore(),
          log,
          secrets,
          allowSyntheticProviders: cfg.settings.allowSyntheticProviders,
        });
        return finish({ ...r }, r.pass, r.pass ? EXIT_OK : EXIT_FAIL);
      }
      default:
        return fail(new IngestError('USAGE', 'unknown command'));
    }
  } catch (e) {
    return fail(e);
  } finally {
    await pool?.end().catch(() => undefined);
    for (const c of clients) c.destroy();
  }
}

/** Appends the migrate command's evidence record to RATIO_EVIDENCE_FILE (only there; see cli.ts). */
export function recordMigrateEvidence(args: string[], env: Env, started: Date, exitCode: number): void {
  const file = env.RATIO_EVIDENCE_FILE;
  if (!file) return;
  const digest = env.RATIO_ARTIFACT_DIGEST && /^sha256:[0-9a-f]{64}$/.test(env.RATIO_ARTIFACT_DIGEST) ? env.RATIO_ARTIFACT_DIGEST : null;
  appendEvidenceFile(
    file,
    buildEvidenceRecord({
      command: 'migrate',
      args: { flags: args.filter((a) => a.startsWith('--')) },
      gitSha: resolveGitSha(env),
      artifactDigest: digest,
      startedAt: started,
      finishedAt: new Date(),
      results: { exitCode },
      pass: exitCode === 0,
      exitCode,
      secrets: secretsFromEnv(env),
    }),
    jsonLineRedactorFor(env),
  );
}
