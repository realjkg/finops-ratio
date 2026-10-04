// Slice 0's reviewed foundation manifest must be loaded LAZILY (Slice 2,
// coordinator decision Q1): importing privilegeModel / foundationManifest may
// do no file-system I/O, because a bundler (Next 16 / Turbopack) rewrites
// __dirname and the read API route imports privilegeModel (through Slice 1's
// worker/db.ts) for REFUSED_PREDEFINED_ROLES. Found by the local e2e under
// `next start`: ENOENT scandir '/ROOT/src/ingest/db/migrations' on every request.
//
// Requirements tested here:
//   - import does no I/O on the migrations directory (it may be unavailable);
//   - FOUNDATION_0001 / REVIEWED_POLICY_SHAPES are computed on first use,
//     memoised, and equal what the eager code produced;
//   - a missing directory, a missing 0001 manifest or a corrupt manifest still
//     FAILS CLOSED at first use, with the same error (code) as the eager load;
//   - the lazy values behave as the read-only arrays they replace.
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, 'db', 'migrations');
const inMigrations = (p: unknown) => typeof p === 'string' && path.resolve(p).startsWith(MIGRATIONS_DIR);

type Mode = 'real' | 'missing-dir' | 'missing-0001' | 'corrupt';
let mode: Mode = 'real';
let migrationsReads: string[] = [];

beforeEach(() => {
  mode = 'real';
  migrationsReads = [];
  const realReaddir = fs.readdirSync.bind(fs);
  const realRead = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (inMigrations(p)) {
      migrationsReads.push(`readdir ${String(p)}`);
      if (mode === 'missing-dir') throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${String(p)}'`), { code: 'ENOENT' });
      if (mode === 'missing-0001') return [];
    }
    return (realReaddir as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (inMigrations(p)) {
      migrationsReads.push(`read ${String(p)}`);
      if (mode === 'corrupt' && String(p).endsWith('.manifest.json')) return '{ not json';
    }
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const load = async () => ({
  pm: await import('./db/privilegeModel'),
  fm: await import('./db/foundationManifest'),
  mf: await import('./db/migrationFiles'),
});

async function errorOf(fn: () => unknown): Promise<{ name: string; code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { name: string; code?: string; message: string };
    return { name: err.name, code: err.code, message: err.message };
  }
  throw new Error('expected an error');
}

describe('lazy foundation manifest: no I/O on import', () => {
  it('importing privilegeModel and foundationManifest reads nothing from the migrations directory', async () => {
    const { pm } = await load();
    expect(migrationsReads).toEqual([]);
    // What the read API needs is available without any I/O.
    expect(Object.keys(pm.REFUSED_PREDEFINED_ROLES)).toContain('pg_read_all_data');
    expect(migrationsReads).toEqual([]);
  });

  it('importing (and Slice 1’s worker/db.ts) succeeds with the migrations directory unavailable', async () => {
    mode = 'missing-dir';
    const { pm } = await load();
    const workerDb = await import('./worker/db');
    expect(typeof workerDb.inspectRole).toBe('function');
    expect(pm.REFUSED_PREDEFINED_ROLES.pg_monitor).toBeTruthy();
  });
});

describe('lazy foundation manifest: computed on first use, memoised, identical values', () => {
  it('FOUNDATION_0001 equals the stored 0001 manifest; loaded once', async () => {
    const { fm, mf } = await load();
    expect(migrationsReads).toEqual([]);
    const expected = mf.loadManifests(MIGRATIONS_DIR)['0001'];
    migrationsReads = [];
    expect([...fm.FOUNDATION_0001]).toEqual([...expected]);
    const afterFirst = migrationsReads.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(fm.FOUNDATION_0001.length).toBe(expected.length);
    expect(fm.FOUNDATION_0001.includes(expected[0])).toBe(true);
    expect(migrationsReads.length).toBe(afterFirst);
  });

  it('REVIEWED_POLICY_SHAPES equals the eager derivation from the manifest', async () => {
    const { pm, mf } = await load();
    const manifest = mf.loadManifests(MIGRATIONS_DIR)['0001'];
    const eager = [
      ...new Set(manifest.filter((e) => e.startsWith('policy:') && !e.startsWith('policy:ratio.tenants:')).map((e) => e.replace(/^policy:[^:]+:/, 'policy:'))),
    ];
    expect([...pm.REVIEWED_POLICY_SHAPES]).toEqual(eager);
    expect(pm.REVIEWED_POLICY_SHAPES.length).toBeGreaterThan(0);
  });

  it('the lazy values behave like the read-only arrays they replace', async () => {
    const { fm, mf } = await load();
    const expected = [...mf.loadManifests(MIGRATIONS_DIR)['0001']];
    const v = fm.FOUNDATION_0001;
    expect(Array.isArray(v)).toBe(true);
    expect(v).toEqual(expected);
    expect(JSON.stringify(v)).toBe(JSON.stringify(expected));
    expect(v.filter((e) => e.startsWith('trigger:'))).toEqual(expected.filter((e) => e.startsWith('trigger:')));
    expect(v.some((e) => e.startsWith('table:'))).toBe(true);
    expect([...v].sort()).toEqual([...expected].sort());
    expect(v[0]).toBe(expected[0]);
    expect(Object.keys(v)).toEqual(Object.keys(expected));
    expect(() => {
      (v as string[]).push('x');
    }).toThrow();
    expect(v).toEqual(expected);
  });
});

describe('lazy foundation manifest: still fails closed at first use, with the eager error', () => {
  const cases: Array<[Mode, { name: string; code?: string; message: RegExp }]> = [
    ['missing-dir', { name: 'Error', code: 'ENOENT', message: /ENOENT/ }],
    ['missing-0001', { name: 'Error', code: undefined, message: /^0001_ratio_schema\.manifest\.json is missing from the migrations directory$/ }],
    ['corrupt', { name: 'MigrationError', code: 'BAD_MANIFEST', message: /0001_ratio_schema\.manifest\.json is not valid JSON/ }],
  ];
  for (const [m, want] of cases) {
    it(`${m}: FOUNDATION_0001 and REVIEWED_POLICY_SHAPES throw on first use (${want.code ?? 'plain Error'})`, async () => {
      mode = m;
      const { fm, pm } = await load();
      for (const use of [() => fm.FOUNDATION_0001.length, () => [...fm.FOUNDATION_0001], () => pm.REVIEWED_POLICY_SHAPES.includes('x')]) {
        const e = await errorOf(use);
        expect(e.name).toBe(want.name);
        expect(e.code).toBe(want.code);
        expect(e.message).toMatch(want.message);
      }
      // Never "succeeds" with an empty manifest: every later use fails too.
      expect(await errorOf(() => fm.FOUNDATION_0001.length)).toMatchObject({ code: want.code });
    });
  }

  it('the eager load produced exactly these errors (reference: loadManifests itself)', async () => {
    const { mf } = await load();
    mode = 'missing-dir';
    expect((await errorOf(() => mf.loadManifests(MIGRATIONS_DIR))).code).toBe('ENOENT');
    mode = 'corrupt';
    expect(await errorOf(() => mf.loadManifests(MIGRATIONS_DIR))).toMatchObject({ name: 'MigrationError', code: 'BAD_MANIFEST' });
  });
});
