// The one typed configuration module for worker commands. Everything external
// (database URLs, endpoints, regions, buckets, credentials) comes from the
// environment; nothing is hard-coded. Validation fails closed with a code and
// never echoes a value.
import os from 'os';
import { IngestError } from './errors';

type Env = Record<string, string | undefined>;

export type RatioEnv = 'development' | 'test' | 'staging' | 'production';
const RATIO_ENVS: readonly RatioEnv[] = ['development', 'test', 'staging', 'production'];

export interface WorkerLimits {
  maxRowsPerBatch: number;
  maxArtifactBytes: number;
  maxBatchBytes: number;
  maxArtifactsPerSet: number;
  insertChunkRows: number;
}

export interface WorkerSettings {
  leaseTtlSeconds: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  tmpDir: string;
  limits: WorkerLimits;
}

export const DEFAULT_LIMITS: WorkerLimits = {
  maxRowsPerBatch: 20_000_000,
  maxArtifactBytes: 5 * 1024 ** 3,
  maxBatchBytes: 20 * 1024 ** 3,
  maxArtifactsPerSet: 1000,
  insertChunkRows: 1000,
};

export const DEFAULT_SETTINGS: WorkerSettings = {
  leaseTtlSeconds: 300,
  maxAttempts: 3,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  tmpDir: os.tmpdir(),
  limits: DEFAULT_LIMITS,
};

export interface S3Settings {
  endpoint: string | undefined;
  region: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
}

export interface WorkerConfig {
  env: RatioEnv;
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  migrateDatabaseUrl: string | undefined;
  sourceS3: S3Settings;
  evidenceS3: S3Settings & { bucket: string | undefined; prefix: string };
  replayFixturesBucket: string | undefined;
  settings: WorkerSettings;
  doctorMaxStalenessHours: number;
  artifactDigest: string | null;
  evidenceFile: string | undefined;
  /** Test-only kill hook (pause after N rows). Non-null only when NODE_ENV === 'test'. */
  testPauseAfterRows: number | null;
  allowFakeSource: boolean;
}

function fail(message: string, code = 'CONFIG_INVALID'): never {
  throw new IngestError(code, message);
}

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^[0-9]+$/.test(raw.trim())) fail(`${name} must be an integer between ${min} and ${max}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function validateBucketName(name: string, what: string): string {
  if (!BUCKET_RE.test(name) || name.includes('..')) fail(`${what} is not a valid bucket name`);
  return name;
}

function endpoint(env: Env, name: string, ratioEnv: RatioEnv): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(`${name} is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${name} must be an http(s) URL`);
  if (u.username || u.password) fail(`${name} must not contain credentials`);
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) fail(`${name} must not contain a query string or fragment`);
  if (u.protocol === 'http:' && ratioEnv === 'production') fail(`${name} must use https when RATIO_ENV=production`);
  return raw.replace(/\/+$/, '');
}

function s3Settings(env: Env, prefix: string, ratioEnv: RatioEnv): S3Settings {
  const ep = endpoint(env, `${prefix}_ENDPOINT`, ratioEnv);
  const region = (env[`${prefix}_REGION`] ?? '').trim() || 'us-east-1';
  if (!/^[a-z0-9-]{2,32}$/.test(region)) fail(`${prefix}_REGION is not a valid region`);
  const id = env[`${prefix}_ACCESS_KEY_ID`];
  const secret = env[`${prefix}_SECRET_ACCESS_KEY`];
  const session = env[`${prefix}_SESSION_TOKEN`];
  if (!!id !== !!secret) fail(`${prefix}_ACCESS_KEY_ID and ${prefix}_SECRET_ACCESS_KEY must be set together`);
  const fps = env[`${prefix}_FORCE_PATH_STYLE`];
  if (fps !== undefined && fps !== '' && fps !== '0' && fps !== '1') fail(`${prefix}_FORCE_PATH_STYLE must be 0 or 1`);
  return {
    endpoint: ep,
    region,
    forcePathStyle: fps === '0' ? false : fps === '1' ? true : ep !== undefined,
    credentials: id && secret ? { accessKeyId: id, secretAccessKey: secret, ...(session ? { sessionToken: session } : {}) } : undefined,
  };
}

/** NODE_ENV=test and RATIO_ENV is not staging/production. */
export function testSwitchesPermitted(env: Env): boolean {
  const ratioEnv = (env.RATIO_ENV ?? '').trim();
  return env.NODE_ENV === 'test' && ratioEnv !== 'staging' && ratioEnv !== 'production';
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const rawEnv = (env.RATIO_ENV ?? '').trim();
  const ratioEnv = (rawEnv === '' ? 'development' : rawEnv) as RatioEnv;
  if (!RATIO_ENVS.includes(ratioEnv)) fail(`RATIO_ENV must be one of ${RATIO_ENVS.join(', ')}`);

  // Test-only switches need NODE_ENV=test AND must never activate in a staging/production deployment.
  const isTestProcess = testSwitchesPermitted(env);
  let testPauseAfterRows: number | null = null;
  if (env.RATIO_TEST_PAUSE_AFTER_ROWS !== undefined && env.RATIO_TEST_PAUSE_AFTER_ROWS !== '') {
    if (!isTestProcess) fail('RATIO_TEST_PAUSE_AFTER_ROWS is a test-only hook: refused unless NODE_ENV=test and RATIO_ENV is not staging/production', 'TEST_HOOK_NOT_ALLOWED');
    testPauseAfterRows = int(env, 'RATIO_TEST_PAUSE_AFTER_ROWS', 0, 1, 100_000_000);
  }

  const digest = env.RATIO_ARTIFACT_DIGEST;
  if (digest !== undefined && digest !== '' && !/^sha256:[0-9a-f]{64}$/.test(digest)) fail('RATIO_ARTIFACT_DIGEST must be sha256:<64 hex>');

  const evidenceBucket = env.RATIO_EVIDENCE_S3_BUCKET || undefined;
  if (evidenceBucket) validateBucketName(evidenceBucket, 'RATIO_EVIDENCE_S3_BUCKET');
  const evidencePrefix = env.RATIO_EVIDENCE_S3_PREFIX ?? '';
  if (evidencePrefix !== '' && (evidencePrefix.length > 256 || evidencePrefix.split('/').some((seg) => !/^[A-Za-z0-9_.-]+$/.test(seg) || seg === '.' || seg === '..'))) {
    fail('RATIO_EVIDENCE_S3_PREFIX must be slash-separated segments of [A-Za-z0-9_.-]');
  }
  const fixturesBucket = env.RATIO_REPLAY_FIXTURES_BUCKET || undefined;
  if (fixturesBucket) validateBucketName(fixturesBucket, 'RATIO_REPLAY_FIXTURES_BUCKET');

  const retryBaseMs = int(env, 'RATIO_RETRY_BASE_MS', DEFAULT_SETTINGS.retryBaseMs, 1, 60_000);
  const retryMaxMs = int(env, 'RATIO_RETRY_MAX_MS', DEFAULT_SETTINGS.retryMaxMs, 1, 600_000);
  if (retryMaxMs < retryBaseMs) fail('RATIO_RETRY_MAX_MS must be >= RATIO_RETRY_BASE_MS');

  return {
    env: ratioEnv,
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.RATIO_DATABASE_URL || undefined,
    migrateDatabaseUrl: env.RATIO_MIGRATE_DATABASE_URL || undefined,
    sourceS3: s3Settings(env, 'RATIO_SOURCE_S3', ratioEnv),
    evidenceS3: { ...s3Settings(env, 'RATIO_EVIDENCE_S3', ratioEnv), bucket: evidenceBucket, prefix: evidencePrefix },
    replayFixturesBucket: fixturesBucket,
    settings: {
      leaseTtlSeconds: int(env, 'RATIO_LEASE_TTL_SECONDS', DEFAULT_SETTINGS.leaseTtlSeconds, 5, 3600),
      maxAttempts: int(env, 'RATIO_MAX_ATTEMPTS', DEFAULT_SETTINGS.maxAttempts, 1, 10),
      retryBaseMs,
      retryMaxMs,
      tmpDir: env.RATIO_TMP_DIR || DEFAULT_SETTINGS.tmpDir,
      limits: {
        maxRowsPerBatch: int(env, 'RATIO_MAX_ROWS_PER_BATCH', DEFAULT_LIMITS.maxRowsPerBatch, 1, 1_000_000_000),
        maxArtifactBytes: int(env, 'RATIO_MAX_ARTIFACT_BYTES', DEFAULT_LIMITS.maxArtifactBytes, 1, Number.MAX_SAFE_INTEGER),
        maxBatchBytes: int(env, 'RATIO_MAX_BATCH_BYTES', DEFAULT_LIMITS.maxBatchBytes, 1, Number.MAX_SAFE_INTEGER),
        maxArtifactsPerSet: int(env, 'RATIO_MAX_ARTIFACTS_PER_SET', DEFAULT_LIMITS.maxArtifactsPerSet, 1, 100_000),
        insertChunkRows: int(env, 'RATIO_INSERT_CHUNK_ROWS', DEFAULT_LIMITS.insertChunkRows, 1, 5000),
      },
    },
    doctorMaxStalenessHours: int(env, 'RATIO_DOCTOR_MAX_STALENESS_HOURS', 48, 1, 24 * 366),
    artifactDigest: digest ? digest : null,
    evidenceFile: env.RATIO_EVIDENCE_FILE || undefined,
    testPauseAfterRows,
    allowFakeSource: isTestProcess && env.RATIO_ALLOW_FAKE_SOURCE === '1',
  };
}

/** Merges partial settings (as tests and library callers pass them) over defaults. */
export function resolveSettings(partial?: Partial<Omit<WorkerSettings, 'limits'>> & { limits?: Partial<WorkerLimits> }): WorkerSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(partial ?? {}),
    limits: { ...DEFAULT_LIMITS, ...(partial?.limits ?? {}) },
  };
}
