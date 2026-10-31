// R2 slice D: engagement mode serves only the engagement surface (proxy.ts); every route file must be classified.
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_ALLOWED_ROUTES, engagementPathAllowed } from './allowlist';
import { proxy } from '../../proxy';

const ROOT = path.resolve(__dirname, '../..');
const routes = (): string[] => (fs.readdirSync(path.join(ROOT, 'pages'), { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => /\.tsx?$/.test(f) && !/(^|\/)_/.test(f)).map((f) => '/' + f.replace(/\.tsx?$/, '').replace(/\/?index$/, ''));
// 404 in engagement mode: demo pages, seed and simulation APIs, shared-token gateway routes, the anonymous ingest door.
const BLOCKED = ['/', '/agent-workflows', '/attribution', '/connectors', '/costsource', '/demo', '/finio', '/finio/demo', '/frameworks', '/hello', '/mission',
  '/outcomes', '/overview', '/prediction', '/reports', '/simulation', '/tokenomics', '/workloads', '/workspace',
  '/api/a2a/handshake', '/api/attribution', '/api/costsource/findings', '/api/costsource/health', '/api/costsource/ingest', '/api/costsource/rows',
  '/api/costsource/sources', '/api/finio/export', '/api/hello', '/api/prediction/accuracy', '/api/prediction/predict', '/api/report/snapshot', '/api/tokenomics',
  '/api/v1/a2a/handshake', '/api/v1/ai/chat', '/api/v1/cm/change', '/api/v1/connectors', '/api/v1/finio/export',
  ...['chat', 'command', 'frank', 'operations', 'report', 'session', 'state', 'status'].map((n) => `/api/v1/simulation/${n}`)];
const at = (p: string) => new NextRequest(new URL(p, 'https://ratio.example.test'));
afterEach(() => vi.unstubAllEnvs());

describe('engagement allowlist', () => {
  it('every page and API route file is classified: allowed or blocked, nothing else', () => {
    const all = routes();
    expect(all.filter((r) => ![...BLOCKED, ...ENGAGEMENT_ALLOWED_ROUTES].includes(r)), 'unclassified routes').toEqual([]);
    for (const r of all) expect(engagementPathAllowed(r), r).toBe(ENGAGEMENT_ALLOWED_ROUTES.includes(r));
  });

  it('the allowed surface is exactly the session, report and machine-token routes, the report page and build assets', () => {
    expect([...ENGAGEMENT_ALLOWED_ROUTES].sort()).toEqual(['/api/auth/login', '/api/auth/logout', '/api/auth/oidc/callback', '/api/auth/oidc/start', '/api/auth/session',
      '/api/v1/costs/published', '/api/v1/reports/engagement', '/api/v1/reports/facts', '/engagement']);
    for (const p of ['/_next/static/chunks/a.js', '/_next/data/build/engagement.json', '/favicon.svg']) expect(engagementPathAllowed(p), p).toBe(true);
    for (const p of ['/_nextx/a', '/engagement/', '/engagement/x', '/ENGAGEMENT', '/api/auth/oidc', '/api/v1/reports', '/favicon.svg.bak', '/api/v1/costs/published/x', '/%2Fengagement']) {
      expect(engagementPathAllowed(p), p).toBe(false);
    }
  });
});

describe('proxy', () => {
  it('outside engagement mode it passes everything through; in engagement mode: allowed paths pass, / redirects to the report page, everything else is a no-store 404', async () => {
    for (const p of ['/', '/demo', '/api/costsource/ingest']) expect(proxy(at(p)).headers.get('x-middleware-next'), p).toBe('1');
    vi.stubEnv('RATIO_MODE', 'engagement');
    expect(proxy(at('/api/v1/reports/facts')).headers.get('x-middleware-next')).toBe('1');
    const home = proxy(at('/'));
    expect([home.status, home.headers.get('location')]).toEqual([307, 'https://ratio.example.test/engagement']);
    for (const p of ['/demo', '/api/costsource/ingest', '/api/v1/simulation/session', '/api/hello', '/mission', '/api/v1/ai/chat']) {
      const r = proxy(at(p));
      expect([r.status, r.headers.get('cache-control'), await r.text()], p).toEqual([404, 'no-store', 'Not found']);
    }
  });

  it('an invalid RATIO_MODE fails closed: 404 for everything', () => {
    vi.stubEnv('RATIO_MODE', 'Engagement');
    for (const p of ['/engagement', '/api/v1/reports/facts', '/demo']) expect(proxy(at(p)).status, p).toBe(404);
  });
});
