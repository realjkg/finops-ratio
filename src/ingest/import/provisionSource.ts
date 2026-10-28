// R3: registers an operator file-drop source (`cli source add`), ported from
// the dev script's provisionSource (scripts/local/local.mjs). Runs as the
// migrator/owner login (RATIO_MIGRATE_DATABASE_URL): the worker role may only
// read tenants and sources. Kind stays focus_file; the layout lives in config.
// Idempotent: the same declaration again is `unchanged`; a different
// declaration for an existing key is refused (a source is never silently
// reconfigured under data it already published).
import { Client } from 'pg';
import { IngestError } from '../errors';
import { validateLocation } from '../sources/s3/layout';
import { declaredProviders } from '../focus/provider';

export interface ProvisionOptions {
  tenantId: string;
  tenantSlug: string;
  sourceKey: string;
  displayName: string;
  providers: readonly string[];
  bucket: string;
  prefix: string;
}

export interface ProvisionResult {
  tenant: string;
  sourceKey: string;
  sourceId: string;
  providers: string[];
  outcome: 'created' | 'unchanged';
}

export async function provisionSource(adminUrl: string, o: ProvisionOptions): Promise<ProvisionResult> {
  const config = { layout: 'ratio-file-drop', bucket: o.bucket, prefix: o.prefix, exportName: o.sourceKey, providers: [...o.providers] };
  validateLocation(config);
  if (!declaredProviders(config)) throw new IngestError('USAGE', '--providers must list known providers (AWS, Microsoft, Google Cloud, Oracle), each once');
  const c = new Client({ connectionString: adminUrl, application_name: 'ratio-source-add' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [o.tenantId]);
    await c.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [o.tenantId, o.tenantSlug]);
    const existing = await c.query(`SELECT id::text AS id, kind, config = $3::jsonb AS same FROM ratio.sources WHERE tenant_id = $1 AND source_key = $2`, [o.tenantId, o.sourceKey, JSON.stringify(config)]);
    let id: string;
    let outcome: ProvisionResult['outcome'];
    if (existing.rowCount === 1) {
      if (existing.rows[0].kind !== 'focus_file' || existing.rows[0].same !== true) {
        throw new IngestError('SOURCE_EXISTS_DIFFERENT', `source ${o.sourceKey} already exists with a different configuration; it is not changed`);
      }
      id = existing.rows[0].id;
      outcome = 'unchanged';
    } else {
      const r = await c.query(
        `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, config)
         VALUES ($1, gen_random_uuid(), $2, 'focus_file', $3, 'public_cloud', '1.0', $4::jsonb) RETURNING id::text AS id`,
        [o.tenantId, o.sourceKey, o.displayName, JSON.stringify(config)],
      );
      id = r.rows[0].id;
      outcome = 'created';
    }
    const commit = await c.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new IngestError('SOURCE_PROVISION_FAILED', 'the provisioning transaction was rolled back');
    return { tenant: o.tenantId, sourceKey: o.sourceKey, sourceId: id, providers: [...o.providers], outcome };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end().catch(() => undefined);
  }
}
