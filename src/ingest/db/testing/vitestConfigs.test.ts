// Round 16 (challenger round 15, L3): the serial DB phase is wired correctly.
// Every *.serial.db.test.ts file is picked up by vitest.db.serial.config.ts
// (one file at a time) and excluded from the parallel vitest.db.config.ts and
// from the fast suite, and `npm run test:db` runs both phases in order.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

async function loadConfig(file: string): Promise<{ test: { include?: string[]; exclude?: string[]; fileParallelism?: boolean } }> {
  const prev = process.env.RATIO_TEST_DATABASE_URL;
  process.env.RATIO_TEST_DATABASE_URL = prev || 'postgres://config-load-only@127.0.0.1:1/x';
  try {
    return (await import(path.join(ROOT, file))).default;
  } finally {
    if (prev === undefined) delete process.env.RATIO_TEST_DATABASE_URL;
    else process.env.RATIO_TEST_DATABASE_URL = prev;
  }
}

const matchesAny = (file: string, globs: string[] = []) => globs.some((g) => path.matchesGlob(file, g));

function testFiles(): string[] {
  return (fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[])
    .map((f) => path.posix.join('src', f.split(path.sep).join('/')))
    .filter((f) => f.endsWith('.test.ts'));
}

describe('serial DB phase wiring', () => {
  it('the known serial files exist and every *.serial.db.test.ts runs in the serial phase only', async () => {
    const serialCfg = (await loadConfig('vitest.db.serial.config.ts')).test;
    const dbCfg = (await loadConfig('vitest.db.config.ts')).test;
    const fastCfg = (await loadConfig('vitest.config.ts')).test;
    const files = testFiles();
    const serial = files.filter((f) => f.endsWith('.serial.db.test.ts'));
    expect(serial).toEqual(
      expect.arrayContaining(['src/ingest/db/memberLogin.serial.db.test.ts', 'src/ingest/db/memberParameter.serial.db.test.ts']),
    );
    expect(serialCfg.fileParallelism).toBe(false);
    for (const f of serial) {
      expect(matchesAny(f, serialCfg.include) && !matchesAny(f, serialCfg.exclude), `${f} in serial phase`).toBe(true);
      expect(matchesAny(f, dbCfg.include) && !matchesAny(f, dbCfg.exclude), `${f} not in parallel phase`).toBe(false);
      expect(matchesAny(f, fastCfg.exclude), `${f} not in fast suite`).toBe(true);
    }
    // and nothing that is not serial runs in the serial phase
    for (const f of files.filter((x) => !x.endsWith('.serial.db.test.ts'))) {
      expect(matchesAny(f, serialCfg.include), `${f} not in serial phase`).toBe(false);
    }
    expect(dbCfg.exclude).toContain('**/*.serial.db.test.ts');
  });

  it('npm run test:db runs the parallel phase, then the serial phase', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:db']).toBe('vitest run --config vitest.db.config.ts && vitest run --config vitest.db.serial.config.ts');
  });
});
