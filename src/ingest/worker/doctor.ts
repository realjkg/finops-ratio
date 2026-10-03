// `worker doctor`: READ-ONLY health checks — DB connectivity, role safety,
// migration version vs code, and per-source last run / freshness. Every
// connection it opens has default_transaction_read_only=on. Any failed check
// makes the result fail (non-zero exit).
import { assertCommitted } from './tx';
import { Client } from 'pg';
import { migrationStatus } from '../db/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../db/migrationFiles';
import { redact } from '../redact';
import { messageOf } from '../errors';
import { createWorkerPool, inspectRole, roleProblems } from './db';
import { canonicalTenant } from './types';
import { DEFAULT_FIRST_PUBLISH_GRACE_HOURS } from '../config';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  data?: Record<string, unknown>;
}

export interface DoctorOptions {
  workerUrl?: string;
  /** Owner/migrator URL used ONLY for the read-only ledger check (see DESIGN §2). */
  migrateUrl?: string;
  tenantIds: string[];
  maxStalenessHours: number;
  /** NEVER_PUBLISHED is skipped for a source created less than this many hours ago (default 48). */
  firstPublishGraceHours?: number;
  migrationsDir?: string;
  secrets?: readonly string[];
}

function errText(e: unknown, secrets: readonly string[]): string {
  const code = (e as { code?: string })?.code;
  return redact(`${code ? code + ': ' : ''}${messageOf(e)}`, secrets).slice(0, 500);
}

async function migrationCheck(opts: DoctorOptions, secrets: readonly string[]): Promise<DoctorCheck> {
  const urls = [opts.migrateUrl, opts.workerUrl].filter((u): u is string => !!u);
  const failures: string[] = [];
  for (const url of urls) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, options: '-c default_transaction_read_only=on', application_name: 'ratio-doctor' });
    c.on('error', () => undefined);
    try {
      await c.connect();
      await c.query('BEGIN READ ONLY');
      const st = await migrationStatus(c, { dir: opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR });
      assertCommitted(await c.query('COMMIT'));
      return {
        name: 'migration_version',
        status: st.matches ? 'pass' : 'fail',
        detail: st.matches ? `schema at ${st.currentVersion}` : `schema ${st.currentVersion ?? 'none'} does not match code ${st.expectedVersion}`,
        data: { expectedVersion: st.expectedVersion, currentVersion: st.currentVersion, problems: st.problems },
      };
    } catch (e) {
      failures.push(errText(e, secrets));
    } finally {
      await c.end().catch(() => undefined);
    }
  }
  return {
    name: 'migration_version',
    status: 'fail',
    detail: `MIGRATION_STATUS_UNAVAILABLE: ${urls.length ? failures.join('; ') : 'no database URL can read the migration ledger'} (set RATIO_MIGRATE_DATABASE_URL or grant the worker login SELECT on public.schema_migrations)`,
  };
}

export async function runDoctor(opts: DoctorOptions): Promise<{ pass: boolean; checks: DoctorCheck[] }> {
  const secrets = opts.secrets ?? [];
  const checks: DoctorCheck[] = [];
  if (!opts.workerUrl) {
    checks.push({ name: 'db_connectivity', status: 'fail', detail: 'RATIO_DATABASE_URL is not set' });
    checks.push(await migrationCheck(opts, secrets));
    return { pass: false, checks };
  }
  const pool = createWorkerPool(opts.workerUrl, { max: 1, readOnly: true, applicationName: 'ratio-doctor' });
  try {
    try {
      await pool.query('SELECT 1');
      checks.push({ name: 'db_connectivity', status: 'pass' });
    } catch (e) {
      checks.push({ name: 'db_connectivity', status: 'fail', detail: errText(e, secrets) });
      checks.push({ name: 'role_safety', status: 'fail', detail: 'not checked: no connection' });
      checks.push(await migrationCheck({ ...opts, workerUrl: undefined }, secrets));
      return { pass: false, checks };
    }
    try {
      const role = await inspectRole(pool);
      const problems = roleProblems(role);
      checks.push({
        name: 'role_safety',
        status: problems.length ? 'fail' : 'pass',
        ...(problems.length ? { detail: problems.join('; ') } : {}),
        data: { superuser: role.superuser, bypassRls: role.bypassRls, canBecomePrivileged: role.canBecomePrivileged, unsafeCapabilities: role.unsafeCapabilities, ownerMember: role.ownerMember, workerMember: role.workerMember },
      });
    } catch (e) {
      checks.push({ name: 'role_safety', status: 'fail', detail: errText(e, secrets) });
    }
    checks.push(await migrationCheck(opts, secrets));
    const grace = opts.firstPublishGraceHours ?? DEFAULT_FIRST_PUBLISH_GRACE_HOURS;
    for (const t of opts.tenantIds) checks.push(...(await sourceChecks(pool, t, opts.maxStalenessHours, grace, secrets)));
  } finally {
    await pool.end().catch(() => undefined);
  }
  return { pass: checks.every((c) => c.status !== 'fail'), checks };
}

async function sourceChecks(
  pool: ReturnType<typeof createWorkerPool>,
  tenantRaw: string,
  maxStalenessHours: number,
  firstPublishGraceHours: number,
  secrets: readonly string[],
): Promise<DoctorCheck[]> {
  const tenantId = canonicalTenant(tenantRaw);
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(
      `SELECT s.source_key, s.enabled,
         (SELECT row_to_json(x) FROM (SELECT status, error_code, finished_at, started_at, lease_expires_at > clock_timestamp() AS live
            FROM ratio.sync_runs WHERE source_id = s.id ORDER BY started_at DESC, id DESC LIMIT 1) x) AS last_run,
         (SELECT max(finished_at) FROM ratio.sync_runs WHERE source_id = s.id AND status = 'succeeded') AS last_success,
         (SELECT max(published_at) FROM ratio.period_publications WHERE source_id = s.id) AS last_published,
         (SELECT count(*)::int FROM ratio.period_publications WHERE source_id = s.id) AS published_periods,
         extract(epoch FROM clock_timestamp() - (SELECT max(finished_at) FROM ratio.sync_runs WHERE source_id = s.id AND status = 'succeeded')) / 3600 AS age_hours,
         extract(epoch FROM clock_timestamp() - s.created_at) / 3600 AS source_age_hours
       FROM ratio.sources s ORDER BY s.source_key`,
    );
    assertCommitted(await c.query('COMMIT'));
    if (r.rowCount === 0) return [{ name: `tenant:${tenantId}`, status: 'fail', detail: 'NO_SOURCES: no sources visible for this tenant' }];
    return r.rows.map((s): DoctorCheck => {
      const name = `source:${tenantId}/${s.source_key}`;
      if (!s.enabled) return { name, status: 'skip', detail: 'source disabled' };
      const last = s.last_run as { status: string; error_code: string | null; live: boolean | null } | null;
      // Doctor has no warning level: inside the grace window NEVER_PUBLISHED is skipped (round-2 L2).
      const neverPublished = Number(s.published_periods) === 0;
      const inGrace = neverPublished && Number(s.source_age_hours) < firstPublishGraceHours;
      const data = {
        firstPublicationGrace: inGrace,
        lastRunStatus: last?.status ?? null,
        lastRunErrorCode: last?.error_code ?? null,
        lastSuccessAt: s.last_success ? new Date(s.last_success).toISOString() : null,
        lastPublishedAt: s.last_published ? new Date(s.last_published).toISOString() : null,
        publishedPeriods: s.published_periods,
        hoursSinceLastSuccess: s.age_hours === null ? null : Math.round(Number(s.age_hours) * 10) / 10,
      };
      const problems: string[] = [];
      if (!s.last_success) problems.push('NEVER_SUCCEEDED: no successful run');
      else if (Number(s.age_hours) > maxStalenessHours) problems.push(`STALE: last successful run older than ${maxStalenessHours}h`);
      // Successful runs that never published anything are not a healthy source (review M4, third round).
      if (neverPublished && !inGrace) problems.push('NEVER_PUBLISHED: no billing period has ever been published');
      if (last && (last.status === 'failed' || last.status === 'abandoned')) problems.push(`LAST_RUN_${last.status.toUpperCase()}: ${last.error_code ?? 'unknown'}`);
      if (last && last.status === 'running' && last.live === false) problems.push('RUN_LEASE_EXPIRED: a run is still marked running with an expired lease');
      return problems.length ? { name, status: 'fail', detail: redact(problems.join('; '), secrets), data } : { name, status: 'pass', data };
    });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return [{ name: `tenant:${tenantId}`, status: 'fail', detail: errText(e, secrets) }];
  } finally {
    c.release();
  }
}
