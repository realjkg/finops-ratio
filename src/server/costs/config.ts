// Configuration of GET /api/v1/costs/published. Pure (no pg at runtime: the
// only import is Slice 0's isTenantId, whose module names pg in a type-only
// import), so the Next startup hook (instrumentation.ts) can use it.
//
//   RATIO_API_TENANT_ID        the Ratio tenant the configured RATIO_API_TOKEN
//                              is bound to (one API key per tenant); canonical UUID
//   RATIO_READER_DATABASE_URL  a LOGIN member of ratio_reader
//
// Validated at startup (instrumentation register) and on every request.
// Missing or invalid ⇒ the route fails closed (503 not_configured).
import { isTenantId } from '@/ingest/db/tenant';

type Env = Record<string, string | undefined>;

export type PublishedCostsConfig = { ok: true; tenantId: string; readerUrl: string } | { ok: false; problems: string[] };

export function publishedCostsConfig(env: Env): PublishedCostsConfig {
  const problems: string[] = [];
  const tenant = env.RATIO_API_TENANT_ID ?? '';
  if (!isTenantId(tenant)) problems.push('RATIO_API_TENANT_ID is missing or not a canonical UUID');
  const readerUrl = env.RATIO_READER_DATABASE_URL?.trim() ?? '';
  if (readerUrl === '') problems.push('RATIO_READER_DATABASE_URL is missing');
  return problems.length ? { ok: false, problems } : { ok: true, tenantId: tenant.toLowerCase(), readerUrl };
}

/**
 * Startup check. Silent when the feature is not configured at all (neither
 * variable set: the zero-env demo). Otherwise an invalid configuration is
 * logged ONCE as a structured error (names only, never values) and the
 * route will answer 503; the app itself keeps starting. Returns validity.
 */
export function checkPublishedCostsStartup(env: Env): boolean {
  const configured = Boolean(env.RATIO_API_TENANT_ID?.trim() || env.RATIO_READER_DATABASE_URL?.trim());
  if (!configured) return true;
  const c = publishedCostsConfig(env);
  if (c.ok) return true;
  console.error(
    JSON.stringify({
      tag: 'published-costs',
      event: 'startup_config_invalid',
      problems: c.problems,
      effect: 'GET /api/v1/costs/published answers 503 not_configured until fixed',
    }),
  );
  return false;
}
