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

// Previous behavior (lenient): kept here only so the RED commit can show the new cases failing.
function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
const meetsFloor = (version: string, floor: string) => cmp(version, floor) >= 0;
const rangeMeetsFloor = (range: string, floor: string) => cmp(range.replace(/^[^\d]*/, ''), floor) >= 0;

describe('floor comparators fail closed', () => {
  it('accepts only plain major.minor.patch versions at or above the floor', () => {
    expect(meetsFloor('16.3.8', '16.3.8')).toBe(true);
    expect(meetsFloor('16.4.0', '16.3.8')).toBe(true);
    expect(meetsFloor('16.3.7', '16.3.8')).toBe(false);
    for (const bad of ['16.3.8-canary.0', '0.35.5-rc.1', '16.3.8+build', '16.4', '16', 'latest', '']) {
      expect(meetsFloor(bad, '16.3.8'), bad).toBe(false);
    }
  });

  it('accepts only a single caret, tilde or exact range whose minimum meets the floor', () => {
    for (const ok of ['^16.3.8', '~16.3.8', '16.3.8', '^16.4.0']) expect(rangeMeetsFloor(ok, '16.3.8'), ok).toBe(true);
    for (const bad of ['^16.3.6', '^16.3.6 || ^16.3.8', '>=16.3.8', '*', 'latest', '^16.3.8-canary.0', '^16.3', '16.x']) {
      expect(rangeMeetsFloor(bad, '16.3.8'), bad).toBe(false);
    }
  });
});

describe('security dependency floors', () => {
  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`${name} resolves at or above ${floor} in every lockfile entry`, () => {
      const entries = Object.entries(lock.packages as Record<string, { version?: string }>).filter(
        ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [path, entry] of entries) expect(meetsFloor(entry.version ?? '', floor), `${path}@${entry.version}`).toBe(true);
    });
  }

  it('package.json declares a patched next minimum', () => {
    expect(rangeMeetsFloor(String(pkg.dependencies.next), FLOORS.next)).toBe(true);
  });
});
