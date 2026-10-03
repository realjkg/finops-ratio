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
  it('refuses without RATIO_ALLOW_DOWN_MIGRATIONS=1', () => {
    expect(codeOf(() => assertDownAllowed({}))).toBe('DOWN_NOT_ALLOWED');
    expect(codeOf(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: 'true' }))).toBe('DOWN_NOT_ALLOWED');
    expect(codeOf(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '' }))).toBe('DOWN_NOT_ALLOWED');
  });

  it('refuses when NODE_ENV=production even with the flag', () => {
    expect(
      codeOf(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '1', NODE_ENV: 'production' })),
    ).toBe('DOWN_NOT_ALLOWED');
  });

  it('refuses when RATIO_ENV=production even with the flag', () => {
    expect(
      codeOf(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'production' })),
    ).toBe('DOWN_NOT_ALLOWED');
    expect(
      codeOf(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'PRODUCTION' })),
    ).toBe('DOWN_NOT_ALLOWED');
  });

  it('allows down in non-production with the explicit flag', () => {
    expect(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '1', NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertDownAllowed({ RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'dev' })).not.toThrow();
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
    const env = { RATIO_ALLOW_DOWN_MIGRATIONS: '1', NODE_ENV: 'test' };
    for (const steps of [0, -1, 1.5, Number.NaN]) {
      await expect(migrateDown(fakeClient, { steps, env })).rejects.toMatchObject({ code: 'INVALID_STEPS' });
    }
    await expect(migrateDown(fakeClient, { steps: 1, env: {} })).rejects.toMatchObject({ code: 'DOWN_NOT_ALLOWED' });
    expect(queries).toEqual([]);
  });
});
