import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lock = JSON.parse(readFileSync(fileURLToPath(new URL('../../package-lock.json', import.meta.url)), 'utf8'));

function isPatched(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6)));
}

describe('Zod advisory remediation', () => {
  it('keeps every locked Zod copy at or above the GHSA-mrhx-c7xc-m3w5 fix', () => {
    const zodPackages = Object.entries(lock.packages)
      .filter(([path]) => path === 'node_modules/zod' || path.endsWith('/node_modules/zod'));

    expect(zodPackages.length).toBeGreaterThan(0);
    for (const [path, { version }] of zodPackages) {
      expect(isPatched(version), `${path} resolves to vulnerable zod@${version}`).toBe(true);
    }
  });
});
