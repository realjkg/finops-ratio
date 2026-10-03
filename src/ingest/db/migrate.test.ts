import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import { MigrationError } from './migrationFiles';
import { assertDownAllowed, migrateDown } from './migrate';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MigrationError);
    return (e as MigrationError).code;
  }
  throw new Error('expected a MigrationError, nothing was thrown');
}

describe('assertDownAllowed', () => {
  const ALLOW = { RATIO_ALLOW_DOWN_MIGRATIONS: '1' };

  it('refuses without RATIO_ALLOW_DOWN_MIGRATIONS=1', () => {
    expect(codeOf(() => assertDownAllowed({ RATIO_ENV: 'test' }))).toBe('DOWN_NOT_ALLOWED');
    expect(codeOf(() => assertDownAllowed({ RATIO_ENV: 'test', RATIO_ALLOW_DOWN_MIGRATIONS: 'true' }))).toBe('DOWN_NOT_ALLOWED');
    expect(codeOf(() => assertDownAllowed({ RATIO_ENV: 'test', RATIO_ALLOW_DOWN_MIGRATIONS: '' }))).toBe('DOWN_NOT_ALLOWED');
  });

  it('refuses when NODE_ENV=production even with the flag and a dev RATIO_ENV', () => {
    expect(codeOf(() => assertDownAllowed({ ...ALLOW, RATIO_ENV: 'development', NODE_ENV: 'production' }))).toBe('DOWN_NOT_ALLOWED');
    expect(codeOf(() => assertDownAllowed({ ...ALLOW, RATIO_ENV: 'test', NODE_ENV: ' Production ' }))).toBe('DOWN_NOT_ALLOWED');
  });

  it('refuses unless RATIO_ENV is development, test or ci (allow-list, trimmed, case-insensitive)', () => {
    for (const RATIO_ENV of [undefined, '', 'production', 'Production ', 'PRODUCTION', 'prod', 'staging', 'preview', 'dev-prod', 'testing']) {
      expect(codeOf(() => assertDownAllowed({ ...ALLOW, RATIO_ENV })), String(RATIO_ENV)).toBe('DOWN_NOT_ALLOWED');
    }
    // NODE_ENV alone never enables down.
    expect(codeOf(() => assertDownAllowed({ ...ALLOW, NODE_ENV: 'test' }))).toBe('DOWN_NOT_ALLOWED');
  });

  it('allows down only with the flag and RATIO_ENV in {development, test, ci}', () => {
    for (const RATIO_ENV of ['development', 'test', 'ci', ' Test ', 'CI']) {
      expect(() => assertDownAllowed({ ...ALLOW, RATIO_ENV, NODE_ENV: 'test' }), RATIO_ENV).not.toThrow();
    }
  });
});

describe('migrateDown argument validation', () => {
  it('migrateDown rejects non-positive / non-integer steps without touching the database', async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as ClientBase;
    const env = { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' };
    for (const steps of [0, -1, 1.5, Number.NaN]) {
      await expect(migrateDown(fakeClient, { steps, env })).rejects.toMatchObject({ code: 'INVALID_STEPS' });
    }
    await expect(migrateDown(fakeClient, { steps: 1, env: {} })).rejects.toMatchObject({ code: 'DOWN_NOT_ALLOWED' });
    expect(queries).toEqual([]);
  });
});
