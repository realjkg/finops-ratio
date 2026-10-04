// The publish-injection test seam (D8) is NOT part of the public read API
// (challenger delta review, code note): readPublishedCosts takes no hooks; the
// seam is a module-level setter refused outside vitest, and no production
// file references it.
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPublishedCosts, setAfterPageHookForTests } from './publishedCosts';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(abs, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) acc.push(abs);
  }
  return acc;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('read API test seam', () => {
  it('readPublishedCosts takes exactly (pool, tenantId, query): no hooks parameter', () => {
    expect(readPublishedCosts.length).toBe(3);
    const src = fs.readFileSync(path.join(__dirname, 'publishedCosts.ts'), 'utf8');
    const sig = /export async function readPublishedCosts\(([\s\S]*?)\): Promise/.exec(src)?.[1] ?? '';
    expect(sig).not.toMatch(/hook/i);
    // Count top-level parameters (generic arguments such as Pick<Pool, 'connect'> contain commas).
    expect(sig.replace(/<[^<>]*>/g, '').split(',').filter((p) => p.trim()).length).toBe(3);
  });

  it('the seam is refused outside vitest', () => {
    vi.stubEnv('VITEST', '');
    expect(() => setAfterPageHookForTests(async () => undefined)).toThrow(/test-only/);
  });

  it('no non-test file under pages/ or src/ references the seam', () => {
    const offenders = [...walk(path.join(ROOT, 'pages')), ...walk(path.join(ROOT, 'src'))]
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith(path.join('server', 'costs', 'publishedCosts.ts')))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('setAfterPageHookForTests'))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
