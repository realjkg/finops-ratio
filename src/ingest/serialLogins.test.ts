// Roles are cluster-global. A COMMITTED login with a dangerous attribute
// (SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB) — or a committed
// dangerous member of a ratio role — makes every concurrent migration, status
// and doctor check in the cluster fail (correctly) while it exists. Such
// tests belong in *.serial.db.test.ts files (vitest.db.serial.config.ts, run
// alone after the parallel phase).
//
// Static guard over every NON-serial DB test file:
//   (a) createLogin(...) may take no third argument, or only an array literal
//       of safe attribute strings (a variable could carry anything);
//   (b) in Slice 1's test files (outside src/ingest/db/, whose rolled-back
//       transaction tests are Slice 0's), no string or template literal may
//       CREATE/ALTER a role with a dangerous attribute or GRANT a role to a
//       login in the same statement text.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const DANGEROUS = /\b(SUPERUSER|BYPASSRLS|REPLICATION|CREATEROLE|CREATEDB)\b/;
const ROLE_DDL = /\b(CREATE|ALTER)\s+ROLE\b/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(abs, acc);
    } else if (e.name.endsWith('.db.test.ts')) acc.push(abs);
  }
  return acc;
}

/** Violations in one source text (exported logic for the self-test below). */
export function violationsIn(file: string, code: string, slice1Owned: boolean): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createLogin' && n.arguments.length >= 3) {
      const attrs = n.arguments[2];
      const safe =
        ts.isArrayLiteralExpression(attrs) &&
        attrs.elements.every((el) => ts.isStringLiteral(el) && !DANGEROUS.test(el.text.toUpperCase()));
      if (!safe) out.push(`${at(n)} createLogin with attributes ${attrs.getText(sf)} (dangerous or not a literal): move to a *.serial.db.test.ts file`);
    }
    if (slice1Owned && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) {
      const text = n.getText(sf);
      if (ROLE_DDL.test(text) && DANGEROUS.test(text.toUpperCase().replace(/\bNO(SUPERUSER|BYPASSRLS|REPLICATION|CREATEROLE|CREATEDB)\b/g, ''))) {
        out.push(`${at(n)} role DDL with a dangerous attribute: move to a *.serial.db.test.ts file`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('dangerous logins only in serial DB test files', () => {
  it('no non-serial *.db.test.ts commits a dangerous login (createLogin attrs; Slice 1 role DDL)', () => {
    const files = walk(SRC).filter((f) => !f.endsWith('.serial.db.test.ts'));
    expect(files.length).toBeGreaterThan(20);
    const dbDir = path.join(SRC, 'ingest', 'db') + path.sep;
    const violations = files.flatMap((f) => violationsIn(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'), !f.startsWith(dbDir)));
    expect(violations).toEqual([]);
  });

  it('detector self-test: every bypass shape is flagged', () => {
    const bad = [
      "await createLogin(db, ['ratio_worker'], ['BYPASSRLS']);",
      "await createLogin(db, ['ratio_worker'], attrs);",
      "import { createLogin as mk } from '../testing/db';",
      "await helpers.createLogin(db, ['ratio_worker']);",
      'const f = createLogin;',
      'await db.pool.query(`CREATE ROLE ${su} NOLOGIN SUPERUSER`);',
      "await db.pool.query('ALTER ROLE x CREATEDB');",
      "await db.pool.query('ALTER ROLE ' + n + ' BYPASSRLS');",
      'await db.pool.query(`ALTER ROLE ${n} ${attrVar}`);',
      "await c.query('CREATE USER ' + n + ' SUPERUSER');",
      'await c.query(`ALTER USER ${n} WITH ${attr}`);',
      'await db.pool.query(`GRANT ${su} TO ${login.name}`);',
      "await db.pool.query('GRANT pg_read_all_data TO ' + n);",
      "await db.pool.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I ' || 'BYPASS' || 'RLS', 'x'); END $$`);",
      "const stmt = 'ALTER ROLE x SUPERUSER';",
    ];
    for (const code of bad) expect(violationsIn('x.db.test.ts', code, true).length, code).toBeGreaterThan(0);
    const ok = [
      "await createLogin(db, ['ratio_worker']);",
      "await createLogin(db, ['ratio_reader'], ['NOINHERIT']);",
      "import { createLogin, seedTenantSource } from '../testing/db';",
      'await db.pool.query(`CREATE ROLE ${r} LOGIN NOSUPERUSER IN ROLE ratio_reader`);',
      'await db.pool.query(`CREATE ROLE ${login} LOGIN IN ROLE ratio_reader`);',
      "await db.pool.query(`ALTER ROLE ${login} IN DATABASE %I SET search_path = public`);",
      'await db.pool.query(`GRANT SELECT ON ratio.cost_facts TO ratio_reader`);',
      'await db.pool.query(`GRANT ratio_worker TO ${l.name}`);',
      "const s = 'refuses a BYPASSRLS login';",
    ];
    for (const code of ok) expect(violationsIn('x.db.test.ts', code, true), code).toEqual([]);
  });
});
