// Published-costs configuration (coordinator decision Q2): RATIO_API_TENANT_ID
// is validated as a canonical UUID at STARTUP (Next instrumentation register())
// and on every request; missing or invalid ⇒ fail closed (503 not_configured).
// The startup check never crashes the app (other routes keep working) and is
// silent when the feature is not configured at all (zero-env demo).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPublishedCostsStartup, publishedCostsConfig } from './config';
import { createPublishedCostsRoute } from './publishedCostsRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';
import { register } from '../../../instrumentation';

const TENANT = '11111111-1111-4111-8111-111111111111';
const URL_ = 'postgres://reader@127.0.0.1:1/ratio';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('C1 publishedCostsConfig', () => {
  it('valid: a canonical UUID and a reader URL', () => {
    expect(publishedCostsConfig({ RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ })).toEqual({ ok: true, tenantId: TENANT, readerUrl: URL_ });
    expect(publishedCostsConfig({ RATIO_API_TENANT_ID: TENANT.toUpperCase(), RATIO_READER_DATABASE_URL: URL_ })).toMatchObject({ ok: true, tenantId: TENANT });
  });

  it('missing or invalid tenant binding ⇒ not ok (names the variable, never echoes the value)', () => {
    for (const v of [undefined, '', ' ', 'tnt_abc', 'not-a-uuid', `${TENANT} `, `{${TENANT}}`, '11111111111141118111111111111111', `${TENANT}\n`]) {
      const r = publishedCostsConfig({ RATIO_API_TENANT_ID: v, RATIO_READER_DATABASE_URL: URL_ });
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) {
        expect(r.problems.join(' ')).toContain('RATIO_API_TENANT_ID');
        if (v && v.trim()) expect(r.problems.join(' ')).not.toContain(v.trim());
      }
    }
  });

  it('missing reader URL ⇒ not ok', () => {
    for (const v of [undefined, '', '   ']) {
      const r = publishedCostsConfig({ RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: v });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.join(' ')).toContain('RATIO_READER_DATABASE_URL');
    }
  });
});

describe('C2 startup check (instrumentation register)', () => {
  it('missing tenant binding while the reader URL is set ⇒ one structured error at startup, no throw', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkPublishedCostsStartup({ RATIO_READER_DATABASE_URL: URL_ })).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line).toMatchObject({ tag: 'published-costs', event: 'startup_config_invalid' });
    expect(JSON.stringify(line)).toContain('RATIO_API_TENANT_ID');
    expect(JSON.stringify(line)).not.toContain('reader@');
  });

  it('invalid tenant binding ⇒ startup error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkPublishedCostsStartup({ RATIO_API_TENANT_ID: 'tnt_abc', RATIO_READER_DATABASE_URL: URL_ })).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('the startup log never includes the invalid tenant value (nor the reader URL), whatever its shape', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const values = ['tnt_LEAKCANARY_1', `LEAKCANARY-${'f'.repeat(8)}`, '11111111-1111-4111-8111-LEAKCANARY99', 'LEAKCANARY with spaces', '"LEAKCANARY"', `${TENANT}LEAKCANARY`];
    for (const RATIO_API_TENANT_ID of values) {
      expect(checkPublishedCostsStartup({ RATIO_API_TENANT_ID, RATIO_READER_DATABASE_URL: 'postgres://reader:URLCANARY@127.0.0.1:1/ratio' })).toBe(false);
    }
    expect(err).toHaveBeenCalledTimes(values.length);
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('LEAKCANARY');
    expect(logged).not.toContain('URLCANARY');
    expect(logged).toContain('RATIO_API_TENANT_ID');
  });

  it('valid configuration ⇒ no error; feature not configured at all ⇒ silent', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkPublishedCostsStartup({ RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ })).toBe(true);
    expect(checkPublishedCostsStartup({})).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('instrumentation register() runs the check in the Node.js runtime only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_READER_DATABASE_URL', URL_);
    vi.stubEnv('RATIO_API_TENANT_ID', 'invalid');
    try {
      await register();
      expect(err).toHaveBeenCalledTimes(1);
      vi.stubEnv('NEXT_RUNTIME', 'edge');
      await register();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('and the route fails closed (503 not_configured) for the same configurations, with no DB work', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const poolFor = vi.fn();
    for (const RATIO_API_TENANT_ID of [undefined, 'invalid']) {
      const route = createPublishedCostsRoute({
        env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID, RATIO_READER_DATABASE_URL: URL_ },
        poolFor: poolFor as never,
        logger: () => undefined,
      });
      const res = await call(route, makeReq({ headers: bearer(), remoteAddress: '10.99.0.1' }));
      expect(res.statusCode).toBe(503);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_configured');
    }
    expect(poolFor).not.toHaveBeenCalled();
  });
});
