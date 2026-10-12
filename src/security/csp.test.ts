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
  const header = async (mode: string) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('RATIO_CSP_MODE', mode);
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(['/:path*']);
    return rules[0].headers[0];
  };

  it('enforces on every path by default; RATIO_CSP_MODE=report-only only reports', async () => {
    expect(await header('')).toEqual({ key: 'Content-Security-Policy', value: prod });
    expect((await header('report-only')).key).toBe('Content-Security-Policy-Report-Only');
  });
});
