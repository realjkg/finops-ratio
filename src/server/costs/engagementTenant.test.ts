// R1: in engagement mode the reader's tenant comes from the engagement config
// (not from RATIO_API_TENANT_ID); non-engagement behavior is unchanged.
// Lives in the costs island next to the reader config it exercises (costs/config.ts imports src/engagement).
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPublishedCostsStartup, publishedCostsConfig } from './config';

const FIXTURE = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reader tenant binding', () => {
  const URL_ = 'postgres://reader@127.0.0.1:1/ratio';
  const TENANT = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';

  it('engagement mode: the tenant comes from the config file', () => {
    expect(publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE, RATIO_READER_DATABASE_URL: URL_ })).toEqual({ ok: true, tenantId: TENANT, readerUrl: URL_ });
  });

  it('engagement mode: a separate RATIO_API_TENANT_ID is refused (names the variable)', () => {
    const r = publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('RATIO_API_TENANT_ID');
  });

  it('engagement mode: an invalid config fails closed (never ok), reader URL still required', () => {
    expect(publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: '/nonexistent', RATIO_READER_DATABASE_URL: URL_ }).ok).toBe(false);
    const r = publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('RATIO_READER_DATABASE_URL');
  });

  it('engagement mode: the published-costs startup check is never silent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkPublishedCostsStartup({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE })).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('non-engagement mode is unchanged: env tenant still binds', () => {
    expect(publishedCostsConfig({ RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ })).toEqual({ ok: true, tenantId: TENANT, readerUrl: URL_ });
    expect(publishedCostsConfig({ RATIO_READER_DATABASE_URL: URL_ }).ok).toBe(false);
  });
});
