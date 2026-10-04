// Pure helpers for the LOCAL, EPHEMERAL Ratio stack (scripts/local/local.mjs).
// No Docker, no network, no database here: everything is unit-tested in
// scripts/local/local.test.mjs. Nothing in this file is a production setting.
import crypto from 'node:crypto';

/** Gitignored; holds the generated local secrets. Removed by `local:down -v`. */
export const LOCAL_STATE_DIR = '.ratio-local';
export const LOCAL_ENV_FILE = `${LOCAL_STATE_DIR}/env`;

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
