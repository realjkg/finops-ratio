import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const lock = JSON.parse(readFileSync(fileURLToPath(new URL('../../package-lock.json', import.meta.url)), 'utf8'));

function isAffected(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major >= 7 && (major < 11 || (major === 11 && minor === 0 && patch < 1));
}

describe('minimatch GHSA-g3hv-75wg-m249 remediation', () => {
  it('keeps every locked vulnerable-range minimatch copy below no vulnerable version', () => {
    const minimatchPackages = Object.entries(lock.packages)
      .filter(([path]) => path === 'node_modules/minimatch' || path.endsWith('/node_modules/minimatch'));

    expect(minimatchPackages.length).toBeGreaterThan(0);
    for (const [path, { version }] of minimatchPackages) {
      expect(isAffected(version), `${path} resolves to vulnerable minimatch@${version}`).toBe(false);
    }
  });
});
