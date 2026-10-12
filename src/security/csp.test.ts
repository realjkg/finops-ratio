import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREPAINT_SCRIPT } from '@/theme/user';
// CommonJS on purpose: next.config.js cannot import TypeScript.
import csp from '../../csp.config.js';
import nextConfig from '../../next.config.js';

const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
const prod = csp.buildCsp({ dev: false, preview: false });

it('pins the sha256 of PREPAINT_SCRIPT (fails if the script text and the hash drift)', () => {
  expect(csp.PREPAINT_HASH).toBe(`'sha256-${createHash('sha256').update(PREPAINT_SCRIPT, 'utf8').digest('base64')}'`);
});

it('_document.tsx inlines PREPAINT_SCRIPT and no other inline script', () => {
  const doc = readFileSync('pages/_document.tsx', 'utf8');
  expect(doc.match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
  expect(doc).toContain('__html: PREPAINT_SCRIPT');
});
describe('policy (exact directives: loosening any one fails)', () => {
  const H = csp.PREPAINT_HASH;
  const parts = (opts: { dev: boolean; preview: boolean }) => csp.buildCsp(opts).split('; ');
  const common = ["default-src 'self'", "style-src-attr 'unsafe-inline'", "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"];

  it('production', () => {
    expect(parts({ dev: false, preview: false })).toEqual([
      "default-src 'self'", `script-src 'self' ${H}`, "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
      "connect-src 'self'", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ]);
    expect(prod.match(/sha256-/g)).toHaveLength(1);
    expect(prod).not.toMatch(/unsafe-eval|vercel|\*/);
    expect(directive(prod, 'script-src')).not.toContain('unsafe-inline');
  });
  it('development adds only eval, <style> injection and ws:', () => {
    expect(parts({ dev: true, preview: false })).toEqual([
      common[0], `script-src 'self' ${H} 'unsafe-eval'`, "style-src 'self' 'unsafe-inline'", common[1], "img-src 'self' data: blob:", common[2], "connect-src 'self' ws:", "frame-src 'none'", ...common.slice(3),
    ]);
  });
  it('Vercel preview adds only the vercel.live hosts', () => {
    expect(parts({ dev: false, preview: true })).toEqual([
      common[0], `script-src 'self' ${H} https://vercel.live`, "style-src 'self' https://vercel.live", common[1], "img-src 'self' data: blob: https://vercel.live https://vercel.com",
      "font-src 'self' https://vercel.live https://assets.vercel.com", "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com", 'frame-src https://vercel.live', ...common.slice(3),
    ]);
  });
});

describe('next.config.js headers', () => {
  afterEach(() => vi.unstubAllEnvs());
  // Next evaluates headers() once, during `next build` (routes-manifest.json); `next start` does not re-read env.
  const keys = async (mode: string) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('RATIO_CSP_MODE', mode);
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(['/:path*']);
    expect(rules[0].headers[0].value).toBe(prod);
    return rules[0].headers.map((h) => h.key);
  };

  it('enforces by default and for any value other than exactly report-only', async () => {
    for (const mode of ['', 'enforce', 'Report-Only', 'off', '1']) expect(await keys(mode), mode).toEqual(['Content-Security-Policy']);
  });
  it('RATIO_CSP_MODE=report-only at build time sends only the report-only header', async () => {
    expect(await keys('report-only')).toEqual(['Content-Security-Policy-Report-Only']);
  });
  it('the image build stage passes RATIO_CSP_MODE through before `npm run build`', () => {
    const docker = readFileSync('infrastructure/simulation/Dockerfile', 'utf8');
    const at = (needle: string) => docker.indexOf(needle);
    expect(at('ARG RATIO_CSP_MODE')).toBeGreaterThan(-1);
    expect(at('ENV RATIO_CSP_MODE=$RATIO_CSP_MODE')).toBeGreaterThan(at('ARG RATIO_CSP_MODE'));
    expect(at('RUN npm run build')).toBeGreaterThan(at('ENV RATIO_CSP_MODE'));
  });
});
