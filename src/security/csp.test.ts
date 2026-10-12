import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREPAINT_SCRIPT } from '@/theme/user';
// CommonJS on purpose: next.config.js cannot import TypeScript.
import csp from '../../csp.config.js';
import nextConfig from '../../next.config.js';

const hashOf = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const directive = (policy: string, name: string) =>
  policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('pre-paint script hash', () => {
  it('pins the sha256 of PREPAINT_SCRIPT (fails if the script text and the hash drift)', () => {
    expect(csp.PREPAINT_HASH).toBe(hashOf(PREPAINT_SCRIPT));
  });

  it('_document.tsx inlines PREPAINT_SCRIPT and no other inline script', () => {
    const doc = readFileSync(join(process.cwd(), 'pages/_document.tsx'), 'utf8');
    expect(doc.match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
    expect(doc).toContain('__html: PREPAINT_SCRIPT');
  });
});

describe('policy', () => {
  const prod = csp.buildCsp({ dev: false, preview: false });

  it('allows scripts only from self plus the one pinned hash, with no unsafe-inline or unsafe-eval', () => {
    expect(directive(prod, 'script-src')).toBe(`script-src 'self' ${csp.PREPAINT_HASH}`);
    expect(prod).not.toMatch(/unsafe-eval/);
    expect(directive(prod, 'style-src')).not.toMatch(/unsafe-inline/);
  });

  it('locks down plugins, base URI, forms and framing; allows only same-origin, data and blob images', () => {
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("base-uri 'self'");
    expect(prod).toContain("form-action 'self'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(directive(prod, 'img-src')).toBe("img-src 'self' data: blob:");
    expect(directive(prod, 'connect-src')).toBe("connect-src 'self'");
  });

  it('adds unsafe-eval to script-src only in development', () => {
    expect(directive(csp.buildCsp({ dev: true, preview: false }), 'script-src')).toContain("'unsafe-eval'");
  });

  it('allows vercel.live only on Vercel preview builds', () => {
    expect(prod).not.toContain('vercel.live');
    expect(directive(csp.buildCsp({ dev: false, preview: true }), 'script-src')).toContain('https://vercel.live');
  });
});

describe('next.config.js headers', () => {
  const rules = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      return nextConfig.headers();
    } finally {
      process.env = saved;
    }
  };

  it('enforces the policy on every path by default', async () => {
    const out = await rules({ NODE_ENV: 'production', RATIO_CSP_MODE: undefined, VERCEL_ENV: undefined });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('/:path*');
    expect(out[0].headers).toEqual([{ key: 'Content-Security-Policy', value: csp.buildCsp({ dev: false, preview: false }) }]);
  });

  it('switches to report-only when RATIO_CSP_MODE=report-only', async () => {
    const out = await rules({ NODE_ENV: 'production', RATIO_CSP_MODE: 'report-only', VERCEL_ENV: undefined });
    expect(out[0].headers[0].key).toBe('Content-Security-Policy-Report-Only');
  });
});
