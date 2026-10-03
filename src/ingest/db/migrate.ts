// Migration runner (pg only). Serialized by a session-level advisory lock,
// every migration in its own transaction, checksum-verified ledger.
import type { ClientBase } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, MigrationError, loadMigrations, type MigrationFile } from './migrationFiles';
import { assertReviewedPrivileges, privilegeModelViolations } from './privilegeModel';

/** Arbitrary constant; advisory locks are scoped to the current database. */
export const MIGRATION_LOCK_KEY = '7307215502148461377';

type Env = Record<string, string | undefined>;

export interface MigrateUpOptions {
  dir?: string;
  /** Required to apply any pending migration marked `-- ratio:phase contract`. */
  allowContract?: boolean;
  hooks?: {
    /** Test hook: runs while the advisory lock is held, before the ledger is read. */
    afterLockAcquired?: () => Promise<void>;
  };
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface MigrateDownOptions {
  steps: number;
  env: Env;
  dir?: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface LedgerRow {
  version: string;
  name: string;
  checksum: string;
  down_checksum: string | null;
  applied_at: Date;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
  name       text NOT NULL,
  checksum   text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  down_checksum text CHECK (down_checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;
// Ledgers created before down checksums were recorded (dev/test only; never
// released) get the column; their NULL down_checksum then reads as drift.
const LEDGER_UPGRADE = `ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS down_checksum text`;

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();

/** Environments in which down migrations may run (allow-list). */
export const DOWN_ALLOWED_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'ci']);

export function isProduction(env: Env): boolean {
  return norm(env.NODE_ENV) === 'production' || norm(env.RATIO_ENV) === 'production';
}

/**
 * Down migrations are for dev/test only: refused when NODE_ENV is production,
 * allowed only when RATIO_ENV (trimmed, lower-cased) is development, test or
 * ci, and even then only with RATIO_ALLOW_DOWN_MIGRATIONS=1.
 */
export function assertDownAllowed(env: Env): void {
  if (isProduction(env)) {
    throw new MigrationError('DOWN_NOT_ALLOWED', 'down migrations are refused when NODE_ENV or RATIO_ENV is production');
  }
  if (!DOWN_ALLOWED_ENVS.has(norm(env.RATIO_ENV))) {
    throw new MigrationError('DOWN_NOT_ALLOWED', 'down migrations require RATIO_ENV to be development, test or ci');
  }
  if (env.RATIO_ALLOW_DOWN_MIGRATIONS !== '1') {
    throw new MigrationError('DOWN_NOT_ALLOWED', 'down migrations require RATIO_ALLOW_DOWN_MIGRATIONS=1');
  }
}

async function readLedger(client: ClientBase): Promise<LedgerRow[]> {
  const r = await client.query<LedgerRow>(
    // to_jsonb(...)->>: also readable (as NULL) on a pre-down_checksum ledger, so read-only status never fails on it.
    `SELECT version, name, checksum, to_jsonb(m) ->> 'down_checksum' AS down_checksum, applied_at
       FROM public.schema_migrations m ORDER BY version`,
  );
  return r.rows;
}

async function ledgerExists(client: ClientBase): Promise<boolean> {
  const r = await client.query<{ e: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`);
  return r.rows[0].e;
}

/** Foundation manifests by version, from the loaded migration files (round 14). */
function manifestsOf(files: MigrationFile[]): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const f of files) if (f.manifest) out[f.version] = f.manifest;
  return out;
}

/** Throws if the applied ledger and the files on disk disagree. */
function verifyApplied(files: MigrationFile[], applied: LedgerRow[]): void {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied) {
    const f = byVersion.get(row.version);
    if (!f) throw new MigrationError('MISSING_FILE', `applied migration ${row.version}_${row.name} not found on disk`);
    if (f.checksum !== row.checksum) {
      throw new MigrationError('CHECKSUM_MISMATCH', `applied migration ${row.version}_${row.name} has been modified since it was applied`);
    }
    if (f.downChecksum !== row.down_checksum) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `the down file of applied migration ${row.version}_${row.name} was changed, added or removed since it was applied`,
      );
    }
  }
}

async function withLock<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  await resetSession(client);
  await client.query('SELECT pg_catalog.pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  const unlock = () => client.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    // Never mask the real failure; a dead session releases the lock anyway.
    await unlock().catch(() => undefined);
    throw e;
  }
  await unlock();
  return result;
}

/**
 * After a migration's SQL, inside its transaction: back to the runner's own
 * role, a search_path the migration cannot have planted anything on, and
 * every deferred constraint trigger fired NOW (not at COMMIT, after the
 * check). The ledger write that follows fires any trigger on the ledger, also
 * before the check; the check then refuses any such trigger (challenger
 * round 4, M1).
 */
async function settle(client: ClientBase): Promise<void> {
  await client.query('RESET ROLE');
  await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
}

/**
 * Returns the connection to a known-clean SESSION state (challenger/Copilot
 * round 7, High A). A migration can run plain `SET …` (not LOCAL), which
 * outlives its COMMIT: a hostile search_path, row_security, a role or a
 * session authorization would then apply to the next migration of the run
 * (or to whoever reuses the client). Run before the lock is taken and after
 * every migration transaction, committed or not:
 *   RESET ROLE; SET SESSION AUTHORIZATION DEFAULT  (RESET ALL does not touch these)
 *   RESET ALL                                        (row_security, session_replication_role, every other GUC)
 *   SET search_path = pg_catalog, pg_temp           (session scope, so the pin survives COMMIT)
 * Chosen over a fresh connection per migration: the advisory lock is held by
 * this session, and a new connection would pick up per-role / per-database
 * defaults (ALTER ROLE|DATABASE … SET) that a migration could also plant,
 * whereas the explicit SET below overrides them. Consequence: migrations run
 * with search_path = pg_catalog, pg_temp, so every object name in a migration
 * must be schema-qualified.
 */
export async function resetSession(client: ClientBase): Promise<void> {
  await client.query('RESET ROLE');
  await client.query('SET SESSION AUTHORIZATION DEFAULT');
  await client.query('RESET ALL');
  await client.query('SET search_path = pg_catalog, pg_temp');
}

/** One migration transaction, followed by a session reset whatever happened. */
async function inMigrationTransaction(client: ClientBase, fn: () => Promise<void>): Promise<void> {
  try {
    await inTransaction(client, fn);
  } catch (e) {
    await resetSession(client).catch(() => undefined); // never mask the real failure
    throw e;
  }
  await resetSession(client);
}

async function inTransaction(client: ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function migrateUp(client: ClientBase, opts: MigrateUpOptions = {}): Promise<{ applied: string[] }> {
  const files = loadMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  const log = opts.log ?? (() => undefined);
  return withLock(client, async () => {
    if (opts.hooks?.afterLockAcquired) await opts.hooks.afterLockAcquired();
    await client.query(LEDGER_DDL);
    await client.query(LEDGER_UPGRADE);
    const applied = await readLedger(client);
    verifyApplied(files, applied);

    const appliedSet = new Set(applied.map((r) => r.version));
    const maxApplied = applied.length ? applied[applied.length - 1].version : null;
    const pending = files.filter((f) => !appliedSet.has(f.version));
    for (const f of pending) {
      if (maxApplied !== null && f.version < maxApplied) {
        throw new MigrationError('OUT_OF_ORDER', `pending migration ${f.version}_${f.name} is older than applied ${maxApplied}`);
      }
    }
    const contract = pending.find((f) => f.phase === 'contract');
    if (contract && !opts.allowContract) {
      throw new MigrationError(
        'CONTRACT_NOT_ALLOWED',
        `pending migration ${contract.version}_${contract.name} is a contract migration; pass --allow-contract once no running release depends on what it removes`,
      );
    }

    const done: string[] = [];
    for (const f of pending) {
      await inMigrationTransaction(client, async () => {
        await client.query(f.upSql);
        await settle(client);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum, down_checksum) VALUES ($1, $2, $3, $4)',
          [f.version, f.name, f.checksum, f.downChecksum],
        );
        // Catalog, not text, and LAST before COMMIT: nothing the migration
        // installed can run after it (see settle()).
        await assertReviewedPrivileges(client, `migration ${f.version}_${f.name}`, { manifests: manifestsOf(files) });
      });
      done.push(f.version);
      log('migrate.applied', { version: f.version, name: f.name, phase: f.phase });
    }
    return { applied: done };
  });
}

export async function migrateDown(client: ClientBase, opts: MigrateDownOptions): Promise<{ reverted: string[] }> {
  const { steps } = opts;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new MigrationError('INVALID_STEPS', 'down steps must be a positive integer');
  }
  assertDownAllowed(opts.env);
  const files = loadMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  const log = opts.log ?? (() => undefined);
  return withLock(client, async () => {
    const applied = (await ledgerExists(client)) ? await readLedger(client) : [];
    verifyApplied(files, applied);
    if (steps > applied.length) {
      throw new MigrationError('INVALID_STEPS', `cannot revert ${steps} migrations; only ${applied.length} applied`);
    }
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const targets = applied.slice(-steps).reverse().map((r) => byVersion.get(r.version)!);
    const missing = targets.find((f) => f.downSql === null);
    if (missing) throw new MigrationError('NO_DOWN', `migration ${missing.version}_${missing.name} has no down file`);

    const reverted: string[] = [];
    for (const f of targets) {
      await inMigrationTransaction(client, async () => {
        await client.query(f.downSql!);
        await settle(client);
        await client.query('DELETE FROM public.schema_migrations WHERE version = $1', [f.version]);
        await assertReviewedPrivileges(client, `down migration ${f.version}_${f.name}`, { manifests: manifestsOf(files) });
      });
      reverted.push(f.version);
      log('migrate.reverted', { version: f.version, name: f.name });
    }
    return { reverted };
  });
}

export interface MigrationStatus {
  expectedVersion: string | null;
  currentVersion: string | null;
  matches: boolean;
  applied: Array<{
    version: string;
    name: string;
    checksum: string;
    downChecksum: string | null;
    appliedAt: string;
    fileChecksum: string | null;
    fileDownChecksum: string | null;
    /** up AND down checksums both equal the files on disk */
    checksumMatches: boolean;
  }>;
  pending: Array<{ version: string; name: string; phase: string; checksum: string }>;
  unknownApplied: string[];
  /** catalog privilege-model violations (privilegeModel.ts); any ⇒ problem PRIVILEGE_MODEL_VIOLATION */
  privilegeProblems: string[];
  problems: string[];
}

/** Read-only: takes no lock and never creates the ledger. */
export async function migrationStatus(client: ClientBase, opts: { dir?: string } = {}): Promise<MigrationStatus> {
  const files = loadMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  // One read-only transaction with a pinned search_path for the ledger read
  // and the catalog privilege check (challenger round 4, L1).
  let applied: LedgerRow[];
  let privilegeProblems: string[];
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    applied = (await ledgerExists(client)) ? await readLedger(client) : [];
    privilegeProblems = await privilegeModelViolations(client, { manifests: manifestsOf(files) });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const appliedSet = new Set(applied.map((r) => r.version));
  const appliedOut = applied.map((r) => {
    const f = byVersion.get(r.version);
    return {
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      downChecksum: r.down_checksum,
      appliedAt: new Date(r.applied_at).toISOString(),
      fileChecksum: f ? f.checksum : null,
      fileDownChecksum: f ? f.downChecksum : null,
      checksumMatches: !!f && f.checksum === r.checksum && f.downChecksum === r.down_checksum,
    };
  });
  const pending = files
    .filter((f) => !appliedSet.has(f.version))
    .map((f) => ({ version: f.version, name: f.name, phase: f.phase, checksum: f.checksum }));
  const unknownApplied = applied.filter((r) => !byVersion.has(r.version)).map((r) => r.version);
  const problems: string[] = [];
  if (pending.length) problems.push('PENDING');
  if (appliedOut.some((a) => a.fileChecksum !== null && !a.checksumMatches)) problems.push('CHECKSUM_MISMATCH');
  if (unknownApplied.length) problems.push('UNKNOWN_APPLIED');
  if (privilegeProblems.length) problems.push('PRIVILEGE_MODEL_VIOLATION');
  return {
    expectedVersion: files.length ? files[files.length - 1].version : null,
    currentVersion: applied.length ? applied[applied.length - 1].version : null,
    matches: problems.length === 0,
    applied: appliedOut,
    pending,
    unknownApplied,
    privilegeProblems,
    problems,
  };
}
