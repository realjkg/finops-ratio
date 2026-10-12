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
describe('policy', () => {
  it('allows scripts only from self plus the pinned hash; no eval, no inline <style>', () => {
    expect(directive(prod, 'script-src')).toBe(`script-src 'self' ${csp.PREPAINT_HASH}`);
    expect(prod).not.toContain('unsafe-eval');
    expect(directive(prod, 'style-src')).toBe("style-src 'self'");
    expect(directive(prod, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
  });
  it('locks down objects, base URI, forms, framing, images and connections', () => {
    expect(prod.split('; ')).toEqual(expect.arrayContaining(["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "img-src 'self' data: blob:", "connect-src 'self'"]));
  });
  it('relaxes eval and <style> injection only in development, vercel.live only on previews', () => {
    const dev = csp.buildCsp({ dev: true, preview: false });
    expect(directive(dev, 'script-src')).toBe(`script-src 'self' ${csp.PREPAINT_HASH} 'unsafe-eval'`);
    expect(directive(dev, 'style-src')).toContain("'unsafe-inline'");
    expect(prod).not.toContain('vercel.live');
    expect(directive(csp.buildCsp({ dev: false, preview: true }), 'script-src')).toContain('https://vercel.live');
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
