// Roles are cluster-global. A COMMITTED login with a dangerous attribute
// (SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB) — or a committed
// dangerous member of a ratio role — makes every concurrent migration, status
// and doctor check in the cluster fail (correctly) while it exists. Such
// tests belong in *.serial.db.test.ts files (vitest.db.serial.config.ts, run
// alone after the parallel phase).
//
// This STATIC rule is the first line; the real control is the RUNTIME
// backstop (testing/dangerousLoginBackstop.ts, a setup file of the parallel DB
// config) that fails any file whose process leaves a dangerous ratio_test_*
// login behind. Statically, over every NON-serial DB test file (files without
// createLogin/ROLE/USER/GRANT text are skipped before parsing):
//   (a) createLogin: only direct calls, with no attributes or a literal array
//       of safe ones; no alias import, member call or passing it around;
//   (b) outside src/ingest/db/ (whose role DDL runs in rolled-back
//       transactions), for every call (all string pieces of all arguments,
//       concatenations and templates, dynamic parts as placeholders) and
//       every standalone literal:
//         - CREATE/ALTER ROLE/USER and CREATE GROUP with a dangerous attribute, or with a
//           dynamic part after the role name (an attribute could hide there),
//           or an IN ROLE / IN GROUP / ROLE / ADMIN / USER clause naming
//           anything but ratio_worker/ratio_reader;
//         - GRANT <role> TO <login>, or ALTER GROUP <role> ADD USER, of
//           anything but ratio_worker/ratio_reader;
//         - DO blocks that touch roles/users.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ATTRS = 'SUPERUSER|BYPASSRLS|REPLICATION|CREATEROLE|CREATEDB';
const DANGEROUS = new RegExp(`(?<!NO)\\b(?:${ATTRS})\\b`);
const DANGEROUS_WORD = new RegExp(`^(?:${ATTRS})$`);
const HOLE = '\u0000';
const PREFILTER = /createLogin|ROLE|USER|GROUP|GRANT/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(abs, acc);
    } else if (e.name.endsWith('.db.test.ts')) acc.push(abs);
  }
  return acc;
}

/** The static text of an expression; every dynamic part becomes HOLE. */
function pieces(n: ts.Expression): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => HOLE + s.literal.text).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return pieces(n.left) + pieces(n.right);
  if (ts.isParenthesizedExpression(n)) return pieces(n.expression);
  if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => (ts.isExpression(e) ? pieces(e) : HOLE)).join(' ');
  return HOLE;
}

/** Role-related problems in one SQL-ish text (upper-cased; dynamic parts are HOLE). */
function sqlProblems(raw: string): string[] {
  const text = raw.toUpperCase();
  const out: string[] = [];
  // CREATE GROUP is CREATE ROLE (NOLOGIN by default) and takes the same attributes and clauses (challenger L4).
  for (const m of text.matchAll(/\b(?:CREATE\s+(?:ROLE|USER|GROUP)|ALTER\s+(?:ROLE|USER))\s+(\S+)([^;]*)/g)) {
    const rest = m[2];
    if (DANGEROUS.test(rest) || DANGEROUS_WORD.test(m[1])) out.push('role DDL with a dangerous attribute');
    else if (rest.includes(HOLE)) out.push('role DDL with a dynamic part after the role name');
    // Copilot M2: membership clauses (IN ROLE / IN GROUP / ROLE / ADMIN / USER) may only name ratio_worker / ratio_reader.
    for (const t of rest.matchAll(/\b(?:IN\s+ROLE|IN\s+GROUP|ADMIN|ROLE|USER)\s+([^\s,;]+(?:\s*,\s*[^\s,;]+)*)/g)) {
      const targets = t[1].split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      if (!targets.every((r) => r === 'RATIO_WORKER' || r === 'RATIO_READER')) out.push('role DDL granting membership in a role other than ratio_worker/ratio_reader');
    }
  }
  // ALTER GROUP g ADD USER x makes x a member of g: only ratio_worker/ratio_reader (challenger L4).
  for (const m of text.matchAll(/\bALTER\s+GROUP\s+(\S+)\s+ADD\s+USER\b/g)) {
    const group = m[1].replace(/^"|"$/g, '');
    if (group !== 'RATIO_WORKER' && group !== 'RATIO_READER') out.push('ALTER GROUP adding members to a role other than ratio_worker/ratio_reader');
  }
  for (const m of text.matchAll(/\bGRANT\s+([^;]*?)\s+TO\s+/g)) {
    const what = m[1];
    if (/\bON\b/.test(what)) continue; // a privilege grant, not a membership
    const roles = what.split(',').map((x) => x.trim());
    if (!roles.every((r) => r === 'RATIO_WORKER' || r === 'RATIO_READER')) out.push('GRANT of a role other than ratio_worker/ratio_reader to a login');
  }
  if (/\bDO\b/.test(text) && /\b(ROLE|USER)\b/.test(text)) out.push('DO block touching roles/users');
  return out;
}

/** Violations in one source text. */
export function violationsIn(file: string, code: string, slice1Owned: boolean): string[] {
  if (!PREFILTER.test(code)) return [];
  const out: string[] = [];
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    // (a) createLogin
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'createLogin' && n.propertyName && n.name.text !== 'createLogin') {
      out.push(`${at(n)} createLogin imported under an alias`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'createLogin') out.push(`${at(n)} createLogin used as a member (not a direct call)`);
    if (ts.isIdentifier(n) && n.text === 'createLogin') {
      const p = n.parent;
      const directCall = ts.isCallExpression(p) && p.expression === n;
      const importName = ts.isImportSpecifier(p);
      if (!directCall && !importName) out.push(`${at(n)} createLogin passed around (not a direct call)`);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createLogin' && n.arguments.length >= 3) {
      const attrs = n.arguments[2];
      const safe = ts.isArrayLiteralExpression(attrs) && attrs.elements.every((el) => ts.isStringLiteral(el) && !DANGEROUS.test(el.text.toUpperCase()));
      if (!safe) out.push(`${at(n)} createLogin with attributes ${attrs.getText(sf)} (dangerous or not a literal)`);
    }
    // (b) role DDL / membership grants / DO blocks
    if (slice1Owned) {
      if (ts.isCallExpression(n) && n.arguments.length) {
        for (const p of sqlProblems(n.arguments.map((a) => pieces(a)).join(' '))) out.push(`${at(n)} ${p}`);
      } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !ts.isCallExpression(n.parent)) {
        for (const p of sqlProblems(pieces(n))) out.push(`${at(n)} ${p}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(out)];
}

describe('dangerous logins only in serial DB test files (static rule)', () => {
  it('no non-serial *.db.test.ts commits a dangerous login', () => {
    const files = walk(SRC).filter((f) => !f.endsWith('.serial.db.test.ts'));
    expect(files.length).toBeGreaterThan(20);
    const dbDir = path.join(SRC, 'ingest', 'db') + path.sep;
    const violations = files.flatMap((f) => violationsIn(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'), !f.startsWith(dbDir)));
    expect(violations).toEqual([]);
  }, 30_000);

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
      "await db.pool.query('CREATE ROLE x LOGIN IN ROLE pg_read_server_files');",
      "await db.pool.query('CREATE ROLE x LOGIN IN GROUP pg_write_server_files');",
      "await db.pool.query('CREATE ROLE x LOGIN IN ROLE ratio_worker, pg_signal_backend');",
      "await db.pool.query('CREATE ROLE x NOLOGIN ROLE ratio_owner');",
      "await db.pool.query('CREATE ROLE x NOLOGIN ADMIN postgres');",
      "await db.pool.query('CREATE USER x IN ROLE ratio_owner');",
      "await db.pool.query('ALTER GROUP pg_read_server_files ADD USER x');",
      "await db.pool.query('ALTER GROUP ratio_owner ADD USER x, y');",
      'await db.pool.query(`ALTER GROUP ${g} ADD USER ${login.name}`);',
      "await db.pool.query('CREATE GROUP g SUPERUSER');",
      "await db.pool.query('CREATE GROUP g WITH BYPASSRLS');",
      "await db.pool.query('CREATE GROUP g IN ROLE pg_signal_backend');",
      'await db.pool.query(`CREATE GROUP ${g} ${attr}`);',
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
      'await db.pool.query(`ALTER GROUP ratio_reader ADD USER ${login.name}`);',
      "await db.pool.query('ALTER GROUP pg_monitor DROP USER x');",
      'await db.pool.query(`CREATE GROUP ${g} NOLOGIN`);',
    ];
    for (const code of ok) expect(violationsIn('x.db.test.ts', code, true), code).toEqual([]);
  });
});
