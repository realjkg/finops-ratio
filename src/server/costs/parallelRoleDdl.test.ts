// Cluster-wide role changes only in serial DB test files (static guard).
//
// Roles are cluster-global. Slice 0's catalog check (memberPrivilegeViolations,
// run by every `migrate`, `migrate --status` and `doctor`) reads a role's
// memberships in one statement and its privileges with has_*_privilege() in a
// later one. has_*_privilege follows the LIVE memberships, not the statement's
// snapshot. So a test file that, in the PARALLEL DB phase, commits a role
// change on an existing login (GRANT <role> TO, REVOKE <role> FROM, ALTER ROLE)
// lets a concurrent check in ANOTHER test database see a half-applied state and
// refuse its migration (the intermittent doctor.db.test.ts failure,
// root-caused by the challenger on 7142a86). Such tests belong in
// *.serial.db.test.ts files, which run alone after the parallel phase.
//
// Rule, over every NON-serial *.db.test.ts in src/: a `.query(...)` call (SQL
// executed directly on a pool or a client) whose SQL text (string pieces of its
// arguments; dynamic parts are placeholders) contains a cluster-wide role
// change must provably run inside BEGIN … ROLLBACK:
//   - cluster-wide role changes:
//       - GRANT <role> TO …;
//       - REVOKE <role> FROM …;
//       - GRANT/REVOKE … ON DATABASE | TABLESPACE | PARAMETER (shared catalogs);
//       - ALTER ROLE | USER | GROUP <name> …, except ALTER ROLE <name>
//         IN DATABASE … (a setting scoped to that test database);
//     object privileges (GRANT … ON <table> TO) and the atomic
//     CREATE ROLE … IN ROLE of createLogin are database-local or atomic, so
//     they are not cluster-wide changes;
//   - "provably inside BEGIN … ROLLBACK": the call is `<client>.query(...)` (not
//     on a pool, which autocommits), AND an enclosing function issues both
//     `query('BEGIN')` and `query('ROLLBACK')`, or the enclosing callback is
//     passed to a function declared in the same file that issues both.
// Like Slice 1's serialLogins.test.ts (this guard extends it to membership and
// login changes on existing roles), it sees literal SQL only: a statement held
// in a variable is a placeholder, and SQL handed to a helper (e.g. a migration
// text for the runner, which runs it in its own transaction) or a test title
// is not a `.query(...)` call.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const HOLE = '\u0000';
const PREFILTER = /\bGRANT\b|\bREVOKE\b|\bALTER\s+(?:ROLE|USER|GROUP)\b/i;

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

/** Cluster-wide role changes in one SQL-ish text (dynamic parts are HOLE). */
export function clusterRoleChanges(raw: string): string[] {
  const text = raw.toUpperCase();
  const out: string[] = [];
  const SHARED = /\bON\s+(?:DATABASE|TABLESPACE|PARAMETER)\b/;
  for (const m of text.matchAll(/\bGRANT\s+([^;]*?)\s+TO\s/g)) {
    if (!/\bON\b/.test(m[1])) out.push('GRANT <role> TO (membership)');
    else if (SHARED.test(m[1])) out.push('GRANT … ON a shared object');
  }
  for (const m of text.matchAll(/\bREVOKE\s+([^;]*?)\s+FROM\s/g)) {
    if (!/\bON\b/.test(m[1])) out.push('REVOKE <role> FROM (membership)');
    else if (SHARED.test(m[1])) out.push('REVOKE … ON a shared object');
  }
  for (const m of text.matchAll(/\bALTER\s+(?:ROLE|USER|GROUP)\s+(\S+)\s*([^;]*)/g)) {
    if (/^IN\s+DATABASE\b/.test(m[2])) continue; // a setting scoped to this test database
    out.push('ALTER ROLE/USER/GROUP (cluster-wide)');
  }
  return out;
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** True when `fn`'s body issues both query('BEGIN…') and query('ROLLBACK…'). */
function beginsAndRollsBack(fn: ts.Node): boolean {
  let begin = false;
  let rollback = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query' && n.arguments.length) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
        if (/^\s*BEGIN\b/i.test(a.text)) begin = true;
        if (/^\s*ROLLBACK\b/i.test(a.text)) rollback = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return begin && rollback;
}

/** Functions declared in the file (function declarations and const = arrow/function) that BEGIN and ROLLBACK. */
function txnHelpers(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && beginsAndRollsBack(n)) out.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFn(n.initializer) && beginsAndRollsBack(n.initializer)) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Is this call provably inside BEGIN … ROLLBACK? */
function inRolledBackTxn(call: ts.CallExpression, helpers: Set<string>): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'query') return false;
  // A pool autocommits each statement.
  if (/(^|\.)\w*pool$/i.test(callee.expression.getText())) return false;
  for (let p: ts.Node | undefined = call.parent; p; p = p.parent) {
    if (!isFn(p)) continue;
    if (beginsAndRollsBack(p)) return true;
    const outer = p.parent;
    if (outer && ts.isCallExpression(outer) && outer.arguments.includes(p as ts.Expression) && ts.isIdentifier(outer.expression) && helpers.has(outer.expression.text)) return true;
  }
  return false;
}

/** Every `.query(...)` call with a cluster-wide role change, and whether it is provably rolled back. */
function roleChangeQueries(file: string, code: string): Array<{ line: number; changes: string[]; rolledBack: boolean }> {
  if (!PREFILTER.test(code)) return [];
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const helpers = txnHelpers(sf);
  const out: Array<{ line: number; changes: string[]; rolledBack: boolean }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.length && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query') {
      const changes = clusterRoleChanges(n.arguments.map((a) => pieces(a)).join(' '));
      if (changes.length) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, changes: [...new Set(changes)], rolledBack: inRolledBackTxn(n, helpers) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Violations in one source text. */
export function parallelRoleDdlViolations(file: string, code: string): string[] {
  return roleChangeQueries(file, code)
    .filter((q) => !q.rolledBack)
    .flatMap((q) => q.changes.map((c) => `${file}:${q.line} ${c} outside BEGIN … ROLLBACK`));
}

describe('cluster-wide role changes only in serial DB test files (static guard)', () => {
  it('no non-serial *.db.test.ts commits a GRANT <role> TO, REVOKE <role> FROM or ALTER ROLE outside BEGIN … ROLLBACK', () => {
    const files = walk(SRC).filter((f) => !f.endsWith('.serial.db.test.ts'));
    expect(files.length).toBeGreaterThan(20);
    const violations = files.flatMap((f) => parallelRoleDdlViolations(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')));
    expect(violations).toEqual([]);
  }, 30_000);

  it('the Slice 0/1 files with role DDL (rolled back, database-local or atomic) pass unchanged', () => {
    for (const f of [
      'src/ingest/db/memberPrivileges.db.test.ts',
      'src/ingest/db/roles.db.test.ts',
      'src/ingest/db/privileges.db.test.ts',
      'src/ingest/db/foundation.db.test.ts',
      'src/ingest/db/immutability.db.test.ts',
      'src/ingest/cli.db.test.ts',
    ]) {
      expect(parallelRoleDdlViolations(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), f).toEqual([]);
    }
    // Not vacuous: these files DO run cluster-wide role changes, all recognised as rolled back.
    const seen = (f: string) => roleChangeQueries(f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const f of ['src/ingest/db/memberPrivileges.db.test.ts', 'src/ingest/db/privileges.db.test.ts']) {
      expect(seen(f).length, f).toBeGreaterThan(5);
      expect(seen(f).every((q) => q.rolledBack), f).toBe(true);
    }
  });

  it('detector self-test: what is flagged and what is not', () => {
    const v = (code: string) => parallelRoleDdlViolations('x.db.test.ts', code);
    // Flagged: autocommit pool, membership and login changes.
    expect(v('await db.pool.query(`GRANT ratio_worker TO ${l.name}`);')).toHaveLength(1);
    expect(v('await db.pool.query(`GRANT ratio_reader TO ${l.name} WITH INHERIT FALSE, SET TRUE`);')).toHaveLength(1);
    expect(v('await db.pool.query(`REVOKE ratio_worker FROM ${l.name}`);')).toHaveLength(1);
    expect(v('await db.pool.query(`ALTER ROLE ${l.name} NOLOGIN`);')).toHaveLength(1);
    expect(v('await db.pool.query(`ALTER USER ${l.name} SET DateStyle = \'SQL, DMY\'`);')).toHaveLength(1);
    expect(v('await pool.query("GRANT CREATE ON DATABASE x TO " + r);')).toHaveLength(1);
    expect(v('await adminPool.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${r}`);')).toHaveLength(1);
    // Flagged: a client with no transaction in sight.
    expect(v('async function f(c) { await c.query(`GRANT ratio_worker TO ${x}`); }')).toHaveLength(1);
    expect(v("async function f(c) { await c.query('BEGIN'); await c.query(`GRANT ratio_worker TO ${x}`); await c.query('COMMIT'); }")).toHaveLength(1);
    // Flagged: a pool call inside a function that rolls back ITS client (the pool statement still autocommits).
    expect(v("async function f(c) { await c.query('BEGIN'); try { await db.pool.query(`GRANT ratio_worker TO ${x}`); } finally { await c.query('ROLLBACK'); } }")).toHaveLength(1);
    // Not flagged: inside BEGIN … ROLLBACK, directly or through a helper of the file.
    expect(v("async function f(c) { await c.query('BEGIN'); try { await c.query(`GRANT ratio_worker TO ${x}`); } finally { await c.query('ROLLBACK'); } }")).toEqual([]);
    expect(
      v("async function inTxn(fn) { const c = x(); await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }\nit('t', async () => { await inTxn(async (c) => { await c.query(`GRANT ${a} TO ${b}`); }); });"),
    ).toEqual([]);
    // Not flagged: database-local or scoped changes.
    expect(v('await db.pool.query(`GRANT SELECT ON ratio.cost_facts TO ratio_reader`);')).toEqual([]);
    expect(v('await db.pool.query(`REVOKE SELECT ON ratio.cost_facts FROM ratio_reader`);')).toEqual([]);
    expect(v("await db.pool.query(`ALTER ROLE ratio_worker IN DATABASE x SET search_path = public`);")).toEqual([]);
    expect(v('await db.pool.query(`CREATE ROLE ${n} LOGIN IN ROLE ratio_reader`);')).toEqual([]);
    // Not flagged: test titles and SQL handed to a helper (not a .query call).
    expect(v("it('ALTER ROLE ratio_worker LOGIN is reported; a grant to a second role', async () => {});")).toEqual([]);
    expect(v("await expectRunnerRefuses('GRANT ratio_worker TO x;');")).toEqual([]);
  });
});
