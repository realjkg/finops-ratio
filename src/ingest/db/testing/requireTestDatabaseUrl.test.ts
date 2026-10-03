import { describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from './requireTestDatabaseUrl';

describe('requireTestDatabaseUrl', () => {
  it('throws when RATIO_TEST_DATABASE_URL is unset', () => {
    expect(() => requireTestDatabaseUrl({})).toThrow(/RATIO_TEST_DATABASE_URL/);
  });

  it('throws when it is blank', () => {
    expect(() => requireTestDatabaseUrl({ RATIO_TEST_DATABASE_URL: '' })).toThrow(/RATIO_TEST_DATABASE_URL/);
    expect(() => requireTestDatabaseUrl({ RATIO_TEST_DATABASE_URL: '   ' })).toThrow(/RATIO_TEST_DATABASE_URL/);
  });

  it('returns the URL when set', () => {
    expect(requireTestDatabaseUrl({ RATIO_TEST_DATABASE_URL: 'postgres://u@h:1/db' })).toBe('postgres://u@h:1/db');
  });
});
