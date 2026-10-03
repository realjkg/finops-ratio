// Migration runner (pg only). Serialized by a session-level advisory lock,
// every migration in its own transaction, checksum-verified ledger.
import type { ClientBase } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, MigrationError, loadMigrations, type MigrationFile } from './migrationFiles';

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
  applied_at: Date;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
  name       text NOT NULL,
  checksum   text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function isProduction(env: Env): boolean {
  return (env.NODE_ENV ?? '').toLowerCase() === 'production' || (env.RATIO_ENV ?? '').toLowerCase() === 'production';
}

/** Down migrations are for dev/test only, and need an explicit opt-in even there. */
export function assertDownAllowed(env: Env): void {
  if (isProduction(env)) {
    throw new MigrationError('DOWN_NOT_ALLOWED', 'down migrations are refused when NODE_ENV or RATIO_ENV is production');
  }
  if (env.RATIO_ALLOW_DOWN_MIGRATIONS !== '1') {
    throw new MigrationError('DOWN_NOT_ALLOWED', 'down migrations require RATIO_ALLOW_DOWN_MIGRATIONS=1');
  }
}

async function readLedger(client: ClientBase): Promise<LedgerRow[]> {
  const r = await client.query<LedgerRow>(
    'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  return r.rows;
}

async function ledgerExists(client: ClientBase): Promise<boolean> {
  const r = await client.query<{ e: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`);
  return r.rows[0].e;
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
  }
}

async function withLock<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  const unlock = () => client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
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
      await inTransaction(client, async () => {
        await client.query(f.upSql);
        await client.query('RESET ROLE');
        await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          f.version,
          f.name,
          f.checksum,
        ]);
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
      await inTransaction(client, async () => {
        await client.query(f.downSql!);
        await client.query('RESET ROLE');
        await client.query('DELETE FROM public.schema_migrations WHERE version = $1', [f.version]);
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
    appliedAt: string;
    fileChecksum: string | null;
    checksumMatches: boolean;
  }>;
  pending: Array<{ version: string; name: string; phase: string; checksum: string }>;
  unknownApplied: string[];
  problems: string[];
}

/** Read-only: takes no lock and never creates the ledger. */
export async function migrationStatus(client: ClientBase, opts: { dir?: string } = {}): Promise<MigrationStatus> {
  const files = loadMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  const applied = (await ledgerExists(client)) ? await readLedger(client) : [];
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const appliedSet = new Set(applied.map((r) => r.version));
  const appliedOut = applied.map((r) => {
    const f = byVersion.get(r.version);
    return {
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      appliedAt: new Date(r.applied_at).toISOString(),
      fileChecksum: f ? f.checksum : null,
      checksumMatches: !!f && f.checksum === r.checksum,
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
  return {
    expectedVersion: files.length ? files[files.length - 1].version : null,
    currentVersion: applied.length ? applied[applied.length - 1].version : null,
    matches: problems.length === 0,
    applied: appliedOut,
    pending,
    unknownApplied,
    problems,
  };
}
