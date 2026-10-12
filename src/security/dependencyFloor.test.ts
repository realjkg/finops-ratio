import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the production-chain advisory floors found by `npm audit --omit=dev`
// (next GHSA range 16.0.0 - 16.3.7, sharp < 0.35.5, source-map-js 1.0.0 - 1.2.1).
// If the lockfile regresses below a floor, this fails before CI audit would.
const FLOORS: Record<string, string> = {
  next: '16.3.8',
  sharp: '0.35.5',
  'source-map-js': '1.2.2',
};

const root = process.cwd();
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

describe('security dependency floors', () => {
  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`${name} resolves at or above ${floor} in every lockfile entry`, () => {
      const entries = Object.entries(lock.packages as Record<string, { version?: string }>).filter(
        ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [path, entry] of entries) {
        expect(cmp(entry.version ?? '0.0.0', floor), `${path}@${entry.version}`).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('package.json declares a patched next minimum', () => {
    const min = String(pkg.dependencies.next).replace(/^[^\d]*/, '');
    expect(cmp(min, FLOORS.next)).toBeGreaterThanOrEqual(0);
  });
});
