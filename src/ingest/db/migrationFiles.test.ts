import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  findDestructiveStatement,
  findTransactionControl,
  loadMigrations,
} from './migrationFiles';

const tmpDirs: string[] = [];
function tmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-migfiles-'));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const EXPAND = '-- ratio:phase expand\n';
const CONTRACT = '-- ratio:phase contract\n';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MigrationError);
    return (e as MigrationError).code;
  }
  throw new Error('expected a MigrationError, nothing was thrown');
}

describe('loadMigrations', () => {
  it('orders migrations by version and pairs down files', () => {
    const dir = tmpDir({
      '0002_second.up.sql': EXPAND + 'CREATE TABLE b(x int);',
      '0001_first.up.sql': EXPAND + 'CREATE TABLE a(x int);',
      '0001_first.down.sql': 'DROP TABLE a;',
      '0010_tenth.up.sql': CONTRACT + 'DROP TABLE b;',
    });
    const migs = loadMigrations(dir);
    expect(migs.map((m) => [m.version, m.name, m.phase, m.downSql !== null])).toEqual([
      ['0001', 'first', 'expand', true],
      ['0002', 'second', 'expand', false],
      ['0010', 'tenth', 'contract', false],
    ]);
  });

  it('checksum is sha256 of the raw up-file bytes', () => {
    const body = EXPAND + 'CREATE TABLE a(x int);\r\n-- trailing\n';
    const dir = tmpDir({ '0001_a.up.sql': body });
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    expect(loadMigrations(dir)[0].checksum).toBe(expected);
    expect(loadMigrations(dir)[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed filenames', () => {
    for (const bad of ['1_a.up.sql', '0001-a.up.sql', '0001_A.up.sql', '0001_a.sql', '0001_a.up.sql.bak', 'README.md']) {
      expect(codeOf(() => loadMigrations(tmpDir({ [bad]: EXPAND })))).toBe('BAD_FILENAME');
    }
  });

  it('rejects duplicate versions', () => {
    const dir = tmpDir({ '0001_a.up.sql': EXPAND, '0001_b.up.sql': EXPAND });
    expect(codeOf(() => loadMigrations(dir))).toBe('DUPLICATE_VERSION');
  });

  it('rejects a down file without an up file', () => {
    const dir = tmpDir({ '0001_a.up.sql': EXPAND, '0002_b.down.sql': 'SELECT 1;' });
    expect(codeOf(() => loadMigrations(dir))).toBe('ORPHAN_DOWN');
  });

  it('rejects a missing migrations directory', () => {
    expect(codeOf(() => loadMigrations(path.join(os.tmpdir(), 'ratio-does-not-exist-' + Date.now())))).toBe('DIR_MISSING');
  });

  it('rejects an up migration without a ratio:phase header', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': 'CREATE TABLE a(x int);' })))).toBe('MISSING_PHASE');
    // A header below the first statement does not count.
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': 'CREATE TABLE a(x int);\n-- ratio:phase expand\n' }))),
    ).toBe('MISSING_PHASE');
  });

  it('rejects an invalid or duplicated phase header', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': '-- ratio:phase sideways\nSELECT 1;' })))).toBe(
      'MISSING_PHASE',
    );
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': '-- ratio:phase expand\n-- ratio:phase contract\nSELECT 1;' }))),
    ).toBe('MISSING_PHASE');
  });

  it('rejects an expand migration containing destructive statements', () => {
    const destructive = [
      'DROP TABLE a;',
      'drop index a_idx;',
      'ALTER TABLE a DROP COLUMN x;',
      'ALTER TABLE a DROP CONSTRAINT a_ck;',
      'ALTER TABLE a RENAME COLUMN x TO y;',
      'ALTER TABLE a RENAME TO b;',
      'ALTER TABLE a ALTER COLUMN x TYPE bigint;',
      'ALTER TABLE a ALTER x TYPE bigint;',
      'TRUNCATE a;',
      'DELETE FROM a;',
    ];
    for (const stmt of destructive) {
      expect(findDestructiveStatement(stmt), stmt).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + stmt })))).toBe('EXPAND_NOT_ADDITIVE');
    }
  });

  it('allows destructive statements in a contract migration and ignores them in comments/bodies', () => {
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': CONTRACT + 'DROP TABLE a;' }))[0].phase).toBe('contract');
    const additive =
      EXPAND +
      "-- DROP TABLE a;\nCREATE TABLE a(x int, note text DEFAULT 'drop table x');\n" +
      'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM a; END $$;\n' +
      'ALTER TABLE a ADD COLUMN y int;\nCOMMENT ON TABLE a IS \'rename me\';';
    expect(findDestructiveStatement(additive)).toBeNull();
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': additive }))[0].phase).toBe('expand');
  });

  it('rejects migration files containing transaction control', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + 'BEGIN;\nCREATE TABLE a(x int);\nCOMMIT;' })))).toBe(
      'TRANSACTION_CONTROL',
    );
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + 'SELECT 1;', '0001_a.down.sql': 'COMMIT;' }))),
    ).toBe('TRANSACTION_CONTROL');
  });

  it('the shipped migrations directory loads cleanly and 0001 is expand', () => {
    const migs = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(migs.length).toBeGreaterThanOrEqual(1);
    expect(migs[0].version).toBe('0001');
    expect(migs[0].phase).toBe('expand');
    expect(migs[0].downSql).not.toBeNull();
  });
});

describe('findTransactionControl', () => {
  it('detects transaction-control statements', () => {
    const bad: Array<[string, string]> = [
      ['BEGIN;', 'BEGIN'],
      ['create table a(); commit;', 'COMMIT'],
      ['start transaction;', 'START'],
      ['SAVEPOINT s1;', 'SAVEPOINT'],
      ['RELEASE SAVEPOINT s1;', 'RELEASE'],
      ['ROLLBACK;', 'ROLLBACK'],
      ['END;', 'END'],
      ['ABORT;', 'ABORT'],
      ["PREPARE TRANSACTION 'x';", 'PREPARE'],
      ['SELECT 1;\n  begin\n;', 'BEGIN'],
    ];
    for (const [sql, kw] of bad) expect(findTransactionControl(sql), sql).toBe(kw);
  });

  it('ignores transaction keywords inside dollar quotes, comments, strings and identifiers', () => {
    const ok = [
      'DO $$ BEGIN RAISE NOTICE \'x\'; END $$;',
      'DO $body$\nBEGIN\n  PERFORM 1;\nEND\n$body$;',
      '-- BEGIN;\nSELECT 1;',
      '/* COMMIT; /* nested */ ROLLBACK; */ SELECT 1;',
      "SELECT 'BEGIN; COMMIT;';",
      "SELECT E'it\\'s; COMMIT;';",
      'SELECT "begin" FROM t;',
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$ SELECT 1; $fn$;',
      'PREPARE q AS SELECT $1::int;',
    ];
    for (const sql of ok) expect(findTransactionControl(sql), sql).toBeNull();
  });
});
