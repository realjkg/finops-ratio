// The only sanctioned way for ingestion code to act on behalf of a tenant:
// one transaction, tenant set with a bound parameter via
// set_config(..., is_local => true) so it can never outlive the transaction.
import type { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isTenantId(value: string): boolean {
  return UUID_RE.test(value);
}

export async function withTenantTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== 'string' || !isTenantId(tenantId)) {
    throw new TypeError('invalid tenant id: expected a canonical UUID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('ratio.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    client.release();
  }
}
