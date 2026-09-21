import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBasePath } from './basePath';

describe('withBasePath', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps root-hosted development URLs unchanged', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    expect(withBasePath('/api/prediction/accuracy')).toBe('/api/prediction/accuracy');
  });

  it('prefixes browser API calls with the Webflow Cloud mount path', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/ratio');
    expect(withBasePath('/api/prediction/accuracy')).toBe('/ratio/api/prediction/accuracy');
  });

  it('normalizes extra slashes and leaves non-root-relative URLs alone', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/ratio/');
    expect(withBasePath('/api/report/snapshot?format=pdf')).toBe('/ratio/api/report/snapshot?format=pdf');
    expect(withBasePath('https://example.com/api')).toBe('https://example.com/api');
  });
});
