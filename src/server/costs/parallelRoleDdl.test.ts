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
// Rule, over EVERY `.query(...)` call of every NON-serial *.db.test.ts in src/
// (no raw-text prefilter: the AST decides, Copilot 4176494775):
//   1. A call that provably runs inside BEGIN … ROLLBACK is fine, whatever its
//      SQL. "Provably" is strict (Copilot 4176494757); anything else is not:
//        - the receiver is a transaction-capable CLIENT (challenger Low on
//          480dd87): a `const` initialised with `await <x>.connect()`,
//          `new Client(…)` with Client imported from 'pg', or `await f(…)`
//          where f is a function of this file that only returns such a
//          client; or the client parameter of a verified helper's callback
//          that is never reassigned. Anything else (a pool, `db.admin`, a
//          `let`, an alias, a plain parameter) counts as autocommit;
//        - BEGIN on the SAME receiver is an unconditional statement (a direct
//          statement of an enclosing block) strictly BEFORE the call, in the
//          same function (a nested function never counts);
//        - nothing ends the transaction on that receiver between the BEGIN
//          and the call (ROLLBACK, COMMIT, END, ABORT, PREPARE TRANSACTION);
//        - the ROLLBACK is unconditional after the call: the FIRST statement
//          of the `finally` of a `try` whose block contains the call, or a
//          later direct statement of an enclosing block with no return,
//          throw, break or continue in between; and nothing commits in
//          between;
//        - or the call is in a callback, on the callback's client parameter,
//          passed to a helper of the same file that itself meets these rules
//          for its call of the callback with that client (e.g. `inTxn`), and
//          the callback never ends the transaction itself.
//   2. Any other call: its SQL is rebuilt from the AST (string literals,
//      templates, `+` concatenation, `const` bindings and `for…of` over array
//      literals); dynamic VALUES are placeholders. It is a finding when:
//        - it contains a cluster-wide role change (SQL comments stripped
//          first, in two readings: outside quoted text, and everywhere):
//            - GRANT <role> TO …;
//            - CREATE ROLE | USER | GROUP … ROLE | ADMIN | USER <existing>
//              (adds existing roles as members; IN ROLE / IN GROUP is atomic
//              for the new role and accepted);
//            - REVOKE <role> FROM …;
//            - GRANT/REVOKE … ON DATABASE | TABLESPACE | PARAMETER (shared
//              catalogs);
//            - ALTER ROLE | USER | GROUP <name> …, except ALTER ROLE <name>
//              IN DATABASE … (a setting scoped to that test database);
//          object privileges (GRANT … ON <table> TO) and the atomic
//          CREATE ROLE … IN ROLE of createLogin are database-local or atomic;
//        - or it cannot be read: a bare variable, a call, an object, or a
//          dynamic part in STATEMENT position (fail closed).
//   3. Any use of `query` that is not a direct `<x>.query(…)` call
//      (.call / .apply / .bind, an alias, destructuring, a computed
//      ['query']) is a finding: the guard cannot see what it runs.
//   4. A finding may only stay if it is on the reviewed ALLOWLIST below (file,
//      SHA-256 of the call's text, reason); an allowlist entry that no longer
//      matches a finding fails too (drift).
// Test titles and SQL handed to a helper (e.g. a migration text for the
// runner, which runs it in its own transaction) are not `.query(...)` calls.
//
// Remaining limits (static analysis of test code, not a sandbox):
//   - only *.db.test.ts files are scanned; shared test helpers (e.g.
//     src/ingest/testing/db.ts: createLogin's atomic CREATE ROLE … IN ROLE and
//     DROP ROLE) are not;
//   - only `query` is a SQL sink: another method that runs SQL (a Cursor, a
//     driver other than pg) is not seen;
//   - SQL that comes from outside the file (imports, files read at run time,
//     production code behind a wrapper) is unreadable: it is a finding unless
//     it runs in a proven BEGIN … ROLLBACK, or is on the reviewed allowlist;
//   - transaction control is recognised only as literal BEGIN / ROLLBACK /
//     COMMIT … strings on the same receiver text; a client passed into a
//     function the file does not declare is not followed (fail closed).
// Slice 1's runtime backstop (src/ingest/testing/dangerousLoginBackstop.ts)
// catches a dangerous login left behind, not a membership change on an
// existing login: for those, this static guard is the control.
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
/** A dynamic VALUE inside SQL text. */
const HOLE = '\u0000';
/** SQL the guard cannot read. */
const UNREADABLE = '\u0001';
const MAX_VARIANTS = 64;

/**
 * Reviewed exceptions: a `.query(...)` call the rules cannot prove harmless,
 * kept after review. Key: file + SHA-256 of the call's text (whitespace
 * collapsed). Any edit of the call, or its removal, fails the guard (drift).
 */
export const ALLOWLIST: ReadonlyArray<{ file: string; sha256: string; reason: string }> = [
  {
    file: 'src/ingest/db/commit.db.test.ts',
    // real.query(sql as string, params as unknown[]) — inside a pass-through proxy object
    sha256: 'f23679c5f808a7ccd9bdabc20bc0cce08aeedb9e962e21bfe1d0da8c53182af2',
    reason:
      "Slice 0. The proxy passes migrateUp's SQL (a copy of the repository's own migrations) to a scratch database, and turns every COMMIT into a ROLLBACK, so nothing it runs is committed. Migration 0001 changes no membership or attribute of an existing login.",
  },
  {
    file: 'src/ingest/db/foundation.db.test.ts',
    // c.query(sqlOverride && f.startsWith(version) ? sqlOverride : fs.readFileSync(...)) — writeManifest
    sha256: '5e51cdf34ad9487dbcb8305cb9a37e9cc88d9ee6f5717a1e7ba9f080ca7999c9',
    reason:
      'Slice 0. Applies the repository migrations (or this file\'s 0002 override: ALTER TABLE ratio.sources … SET DEFAULT) to a fresh scratch database, as the manifest script does: the same SQL the runner applies to every test database. It creates the ratio roles only if missing and changes no membership or attribute of an existing login.',
  },
  {
    file: 'src/ingest/db/immutability.db.test.ts',
    // zombie.query(z.sql, z.params) — raceAgainstUncommittedPublish
    sha256: '7f102be5081acc01d8c168ee0a5fcb2640132d490e5ef506fb137ae56668fbca',
    reason:
      "Slice 0. z.sql comes from this file's zombieSql callbacks: a DELETE FROM ratio.cost_facts and an UPDATE of ratio.ingest_artifacts, both database-local DML. The zombie client's BEGIN is issued in a loop (not provable statically), and the test rolls it back.",
  },
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(abs, acc);
    } else if (e.name.endsWith('.db.test.ts')) acc.push(abs);
  }
  return acc;
}

/**
 * SQL comments removed (challenger Low on 480dd87, (c)). Two readings, both
 * matched: comments outside quoted text only (a `--` inside '…' is text), and
 * comments everywhere (a comment inside an EXECUTE '…' string is a comment
 * when that string runs). Nested block comments are handled.
 */
function withoutComments(sql: string, respectQuotes: boolean): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (respectQuotes && (ch === "'" || ch === '"')) {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Cluster-wide role changes in one SQL-ish text (dynamic parts are HOLE). */
export function clusterRoleChanges(raw: string): string[] {
  const found = new Set<string>();
  for (const variant of [withoutComments(raw, true), withoutComments(raw, false)]) for (const c of roleChangesIn(variant)) found.add(c);
  return [...found];
}

function roleChangesIn(raw: string): string[] {
  const text = raw.toUpperCase();
  const out: string[] = [];
  // CREATE ROLE … ROLE / ADMIN / USER <existing> makes EXISTING roles members of
  // the new role (challenger Low on 480dd87, (b)); IN ROLE / IN GROUP only makes
  // the new role a member: atomic for a new role, accepted.
  for (const m of text.matchAll(/\bCREATE\s+(?:ROLE|USER|GROUP)\s+(\S+)([^;]*)/g)) {
    const rest = m[2].replace(/\bIN\s+(?:ROLE|GROUP)\s+[^\s,;]+(?:\s*,\s*[^\s,;]+)*/g, ' ');
    if (/\b(?:ROLE|ADMIN|USER)\s+\S/.test(rest)) out.push('CREATE ROLE … ROLE/ADMIN/USER (adds existing roles as members)');
  }
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

// --- transactions -------------------------------------------------------------

type Fn = ts.FunctionLikeDeclaration;
const isFn = (n: ts.Node): n is Fn =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const fnOf = (n: ts.Node): Fn | undefined => {
  for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p;
  return undefined;
};

/** Strips `await`, parentheses and a trailing `.catch(...)`. */
function core(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'catch') e = e.expression.expression;
    else return e;
  }
}

type Ctl = 'BEGIN' | 'ROLLBACK' | 'END';
function ctlKind(sql: string): Ctl | null {
  const s = sql.trim().toUpperCase();
  if (/^(BEGIN|START\s+TRANSACTION)\b/.test(s)) return 'BEGIN';
  if (/^ROLLBACK\s+(TO|PREPARED)\b/.test(s)) return null;
  if (/^(ROLLBACK|ABORT)\b/.test(s)) return 'ROLLBACK';
  if (/^(COMMIT|END|PREPARE\s+TRANSACTION)\b/.test(s)) return 'END';
  return null;
}

/** `<recv>.query('<literal>')` (await / .catch() stripped). */
function literalQuery(e: ts.Expression): { recv: string; ctl: Ctl | null; node: ts.CallExpression } | null {
  const c = core(e);
  if (!ts.isCallExpression(c) || !ts.isPropertyAccessExpression(c.expression) || c.expression.name.text !== 'query' || !c.arguments.length) return null;
  const a = c.arguments[0];
  if (!ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a)) return null;
  return { recv: c.expression.expression.getText(), ctl: ctlKind(a.text), node: c };
}

/** The transaction control a direct statement issues on `recv`, if any. */
function stmtCtl(st: ts.Statement | undefined, recv: string): Ctl | null {
  if (!st || !ts.isExpressionStatement(st)) return null;
  const q = literalQuery(st.expression);
  return q && q.recv === recv ? q.ctl : null;
}

/** Every transaction-control call on `recv` anywhere under `scope` (nested functions included: fail closed). */
function controls(scope: ts.Node, recv: string): Array<{ pos: number; kind: Ctl }> {
  const out: Array<{ pos: number; kind: Ctl }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const q = literalQuery(n);
      if (q && q.node === n && q.recv === recv && q.ctl) out.push({ pos: n.getStart(), kind: q.ctl });
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/** A return, throw, break or continue under `n` (not inside a nested function). */
function hasEarlyExit(n: ts.Node): boolean {
  let found = false;
  const visit = (m: ts.Node) => {
    if (found || (m !== n && isFn(m))) return;
    if (ts.isReturnStatement(m) || ts.isThrowStatement(m) || ts.isBreakStatement(m) || ts.isContinueStatement(m)) {
      found = true;
      return;
    }
    ts.forEachChild(m, visit);
  };
  visit(n);
  return found;
}

// --- which receivers are transaction-capable clients (challenger Low on 480dd87, (a), (e))

const declOf = (id: ts.Identifier, r: Resolver): ts.Declaration | undefined => {
  const sym = r.checker.getSymbolAtLocation(id);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
};

/** `Client` named-imported from 'pg' (a dedicated connection). */
function pgClientClass(id: ts.Identifier, r: Resolver): boolean {
  const d = declOf(id, r);
  if (!d || !ts.isImportSpecifier(d)) return false;
  const mod = d.parent.parent.parent.moduleSpecifier;
  return (d.propertyName ?? d.name).text === 'Client' && ts.isStringLiteral(mod) && mod.text === 'pg';
}

/** A function of this file whose every `return` (it has at least one) is a provable client. */
function clientFactory(id: ts.Identifier, r: Resolver, depth: number): boolean {
  const d = declOf(id, r);
  const fn = d && ts.isFunctionDeclaration(d) ? d : d && ts.isVariableDeclaration(d) && d.initializer && isFn(d.initializer) ? d.initializer : undefined;
  if (!fn || !fn.body || !ts.isBlock(fn.body)) return false;
  const returns: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && isFn(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return returns.length > 0 && returns.every((ret) => ret.expression !== undefined && ts.isIdentifier(ret.expression) && provableClient(ret.expression, r, depth + 1));
}

/**
 * A receiver is a transaction-capable client only when it is a `const`
 * initialised with `await <x>.connect()`, `new Client(…)` (Client from 'pg'),
 * or `await f(…)` where f is a function of this file returning such a client.
 * Anything else (a pool under another name, `db.admin`, a `let`, a parameter
 * outside a verified helper, an import) counts as autocommit.
 */
function provableClient(e: ts.Expression, r: Resolver, depth = 0): boolean {
  if (depth > 4 || !ts.isIdentifier(e)) return false;
  const d = declOf(e, r);
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
  const list = d.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || ts.isForOfStatement(list.parent)) return false;
  const init = d.initializer;
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) return pgClientClass(init.expression, r);
  if (!ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return false;
  const call = init.expression;
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'connect' && call.arguments.length === 0) return true;
  if (ts.isIdentifier(call.expression)) return clientFactory(call.expression, r, depth);
  return false;
}

/** An assignment to `name` anywhere under `scope`. */
function assignedIn(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left) && n.left.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Is `call` (receiver `recvExpr`) provably inside BEGIN … ROLLBACK on that receiver, within `fn` itself? */
function rolledBackWithin(call: ts.Node, recvExpr: ts.Expression, fn: Fn | undefined, r: Resolver): boolean {
  if (!fn || !fn.body || !ts.isBlock(fn.body)) return false;
  if (!provableClient(recvExpr, r)) return false;
  const recv = recvExpr.getText();
  // The enclosing blocks of the call inside fn, innermost first, with the call's statement in each.
  const chain: Array<{ block: ts.Block; stmt: ts.Statement }> = [];
  for (let n: ts.Node = call; n !== fn; n = n.parent) {
    if (n !== call && isFn(n)) return false; // inside a nested function: never
    if (ts.isBlock(n.parent)) chain.push({ block: n.parent, stmt: n as ts.Statement });
  }
  const ctl = controls(fn.body, recv);
  const at = call.getStart();
  // 1. An unconditional BEGIN on recv strictly before the call.
  let begin = -1;
  for (const { block, stmt } of chain) {
    for (const st of block.statements) {
      if (st === stmt) break;
      if (stmtCtl(st, recv) === 'BEGIN') begin = Math.max(begin, st.getStart());
    }
  }
  if (begin < 0) return false;
  // 2. Nothing ends the transaction between that BEGIN and the call.
  if (ctl.some((c) => c.pos > begin && c.pos < at && c.kind !== 'BEGIN')) return false;
  // 3a. The first statement of the finally of an enclosing try (call in its try block) is the ROLLBACK.
  for (let n: ts.Node = call; n !== fn; n = n.parent) {
    const p = n.parent;
    if (ts.isTryStatement(p) && p.tryBlock === n && p.finallyBlock && stmtCtl(p.finallyBlock.statements[0], recv) === 'ROLLBACK') {
      if (!ctl.some((c) => c.kind === 'END' && c.pos > at && c.pos < p.tryBlock.getEnd())) return true;
    }
  }
  // 3b. Straight line: a later direct statement of an enclosing block is the ROLLBACK, no early exit or commit in between.
  for (const { block, stmt } of chain) {
    const i = block.statements.indexOf(stmt);
    const after = block.statements.slice(i + 1);
    const j = after.findIndex((st) => stmtCtl(st, recv) === 'ROLLBACK');
    if (j < 0) continue;
    if ([stmt, ...after.slice(0, j)].some(hasEarlyExit)) continue;
    if (ctl.some((c) => c.kind === 'END' && c.pos > at && c.pos < after[j].getStart())) continue;
    return true;
  }
  return false;
}

/** Helpers of the file that call a callback parameter with a client inside a verified BEGIN … ROLLBACK: name → callback argument indexes. */
function verifiedHelpers(sf: ts.SourceFile, r: Resolver): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const check = (name: string, fn: Fn) => {
    for (const p of fn.parameters) {
      if (!ts.isIdentifier(p.name)) continue;
      const cb = p.name.text;
      const calls: ts.CallExpression[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === cb) calls.push(n);
        ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
      if (!calls.length) continue;
      const width = Math.max(...calls.map((c) => c.arguments.length));
      for (let k = 0; k < width; k += 1) {
        const ok = calls.every((c) => {
          const a = c.arguments[k];
          return a !== undefined && ts.isIdentifier(a) && rolledBackWithin(c, a, fn, r);
        });
        if (ok) {
          if (!out.has(name)) out.set(name, new Set());
          out.get(name)!.add(k);
        }
      }
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) check(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFn(n.initializer)) check(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The call is on a callback's client parameter, inside a verified helper; the
 * callback never ends the transaction itself and never reassigns that
 * parameter (challenger Low on 480dd87, (e)).
 */
function viaHelper(call: ts.Node, recvExpr: ts.Expression, helpers: Map<string, Set<number>>): boolean {
  const f = fnOf(call);
  if (!f || !f.body || !ts.isIdentifier(recvExpr)) return false;
  const recv = recvExpr.text;
  if (assignedIn(f.body, recv)) return false;
  const k = f.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === recv);
  if (k < 0) return false;
  const outer = f.parent;
  if (!outer || !ts.isCallExpression(outer) || !outer.arguments.some((a) => a === f) || !ts.isIdentifier(outer.expression)) return false;
  if (!helpers.get(outer.expression.text)?.has(k)) return false;
  return !controls(f.body, recv).some((c) => c.kind !== 'BEGIN');
}

// --- SQL text ------------------------------------------------------------------

/**
 * Resolves an identifier to the expressions it can hold, with the TypeScript
 * checker of a one-file program (imports are not followed: unreadable):
 *   - a `const` with an initializer;
 *   - a `for (const x of [a, b])` variable over an array literal (each element);
 *   - a parameter of a named function whose EVERY reference in the file is a
 *     direct call: the arguments at that position (a function passed around,
 *     or a call that omits the argument, is unreadable).
 * Anything else (let, imports, destructuring, properties) resolves to nothing.
 */
interface Resolver {
  checker: ts.TypeChecker;
  values(id: ts.Identifier): ts.Expression[] | null;
}

function resolverFor(file: string, sf: ts.SourceFile): Resolver {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? sf : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === file,
    readFile: () => undefined,
  };
  const checker = ts.createProgram({ rootNames: [file], options: { noResolve: true, noLib: true, types: [] }, host }).getTypeChecker();
  return {
    checker,
    values(id) {
      const sym = checker.getSymbolAtLocation(id);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (!decl) return null;
      if (ts.isVariableDeclaration(decl)) {
        const list = decl.parent;
        if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
        if (ts.isForOfStatement(list.parent)) {
          const e = list.parent.expression;
          if (!ts.isArrayLiteralExpression(e) || e.elements.some((x) => ts.isSpreadElement(x))) return null;
          return [...e.elements] as ts.Expression[];
        }
        return decl.initializer ? [decl.initializer] : null;
      }
      if (ts.isParameter(decl) && isFn(decl.parent)) {
        const fn = decl.parent;
        const idx = fn.parameters.indexOf(decl);
        const nameNode = ts.isFunctionDeclaration(fn) && fn.name ? fn.name : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name : undefined;
        const fsym = nameNode && checker.getSymbolAtLocation(nameNode);
        if (!nameNode || !fsym) return null;
        const args: ts.Expression[] = [];
        let ok = true;
        const visit = (n: ts.Node) => {
          if (ts.isIdentifier(n) && n !== nameNode && checker.getSymbolAtLocation(n) === fsym) {
            const p = n.parent;
            if (ts.isCallExpression(p) && p.expression === n && p.arguments[idx]) args.push(p.arguments[idx]);
            else ok = false;
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return ok && args.length ? args : null;
      }
      return null;
    },
  };
}

/** `<x>.replace(/'/g, "''")`: SQL quote doubling (keywords unchanged), transparent for the scan. */
function quoteDoubling(e: ts.Expression): ts.Expression | null {
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== 'replace' || e.arguments.length !== 2) return null;
  const [re, by] = e.arguments;
  return ts.isRegularExpressionLiteral(re) && re.text === "/'/g" && ts.isStringLiteral(by) && by.text === "''" ? e.expression.expression : null;
}

/** Every SQL text an expression can be (HOLE: a dynamic value; UNREADABLE: cannot be read). */
function sqlTexts(e: ts.Expression, r: Resolver, depth = 0): string[] {
  if (depth > 8) return [UNREADABLE];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return sqlTexts(e.expression, r, depth + 1);
  const unquoted = quoteDoubling(e);
  if (unquoted) return sqlTexts(unquoted, r, depth + 1);
  const cross = (a: string[], b: string[]) => (a.length * b.length > MAX_VARIANTS ? [UNREADABLE] : a.flatMap((x) => b.map((y) => x + y)));
  /** A part inside a larger text: resolved when possible, else a value placeholder. */
  const part = (x: ts.Expression): string[] => {
    const t = sqlTexts(x, r, depth + 1);
    return t.some((s) => s.includes(UNREADABLE)) ? [HOLE] : t;
  };
  if (ts.isTemplateExpression(e)) {
    let acc = [e.head.text];
    for (const s of e.templateSpans) acc = cross(cross(acc, part(s.expression)), [s.literal.text]);
    return acc;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return cross(part(e.left), part(e.right));
  if (ts.isIdentifier(e)) {
    const v = r.values(e);
    return v && v.length ? v.flatMap((x) => sqlTexts(x, r, depth + 1)) : [UNREADABLE];
  }
  return [UNREADABLE];
}

/** A HOLE where a whole statement could be (start of the text or of a statement, or inside EXECUTE / format('…')). */
function statementHole(text: string): boolean {
  for (let i = text.indexOf(HOLE); i >= 0; i = text.indexOf(HOLE, i + 1)) {
    const seg = text.slice(0, i).split(/;|\$\$|\$[a-z_]*\$/i).pop() ?? '';
    if (/^\s*$/.test(seg) || /\bEXECUTE\s*'?$/i.test(seg) || /\bformat\(\s*'$/i.test(seg)) return true;
  }
  return false;
}

// --- the scan --------------------------------------------------------------------

export interface QueryFinding {
  file: string;
  line: number;
  sha256: string;
  problems: string[];
}

const callHash = (n: ts.Node) => crypto.createHash('sha256').update(n.getText().replace(/\s+/g, ' ').trim()).digest('hex');

/** Every `.query(...)` call of a file, judged by the rules above: the findings (before the allowlist). */
export function queryFindings(file: string, code: string): QueryFinding[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const resolver = resolverFor(file, sf);
  const helpers = verifiedHelpers(sf, resolver);
  const out: QueryFinding[] = [];
  /** An indirect use is identified by its whole enclosing statement (the bare `x.query` text is not distinctive). */
  const finding = (n: ts.Node, problem: string) => {
    let st: ts.Node = n;
    while (st.parent && !ts.isSourceFile(st.parent) && !ts.isBlock(st.parent)) st = st.parent;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, sha256: callHash(st), problems: [problem] });
  };
  const visit = (n: ts.Node) => {
    // (d) Any use of `query` other than a direct `<x>.query(…)` call: .call /
    // .apply / .bind, an alias, destructuring, a computed member.
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'query' && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
      finding(n, 'indirect use of query (not a direct .query(...) call)');
    }
    if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) && n.argumentExpression.text === 'query') {
      finding(n, "computed ['query'] member");
    }
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'query') finding(n, 'query destructured from an object');
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query') {
      const recvExpr = n.expression.expression;
      const pool = /(^|\.)\w*pool$/i.test(recvExpr.getText());
      const safe = !pool && (rolledBackWithin(n, recvExpr, fnOf(n), resolver) || viaHelper(n, recvExpr, helpers));
      if (!safe) {
        const texts = n.arguments.length ? sqlTexts(n.arguments[0], resolver) : [UNREADABLE];
        const problems = new Set<string>();
        for (const t of texts) {
          if (t.includes(UNREADABLE) || statementHole(t)) problems.add('SQL the guard cannot read');
          else for (const c of clusterRoleChanges(t)) problems.add(c);
        }
        if (problems.size) {
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, sha256: callHash(n), problems: [...problems] });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Findings as messages (the allowlist is applied by the repository scan, not here). */
export function parallelRoleDdlViolations(file: string, code: string): string[] {
  return queryFindings(file, code).flatMap((f) => f.problems.map((p) => `${f.file}:${f.line} ${p} outside BEGIN … ROLLBACK`));
}

/** How many `.query(...)` calls in a file the rules accept as rolled back (for the non-vacuity check). */
function rolledBackQueries(file: string, code: string): number {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const resolver = resolverFor(file, sf);
  const helpers = verifiedHelpers(sf, resolver);
  let n = 0;
  const visit = (m: ts.Node) => {
    if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && m.expression.name.text === 'query') {
      const recvExpr = m.expression.expression;
      if (!/(^|\.)\w*pool$/i.test(recvExpr.getText()) && (rolledBackWithin(m, recvExpr, fnOf(m), resolver) || viaHelper(m, recvExpr, helpers))) n += 1;
    }
    ts.forEachChild(m, visit);
  };
  visit(sf);
  return n;
}

/** The repository scan: findings not on the allowlist, and allowlist entries that match nothing. */
function repositoryScan(allowlist: typeof ALLOWLIST = ALLOWLIST): { unlisted: QueryFinding[]; stale: typeof ALLOWLIST; all: QueryFinding[] } {
  const files = walk(SRC).filter((f) => !f.endsWith('.serial.db.test.ts'));
  const all = files.flatMap((f) => queryFindings(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')));
  const listed = (f: QueryFinding) => allowlist.some((a) => a.file === f.file && a.sha256 === f.sha256);
  return {
    all,
    unlisted: all.filter((f) => !listed(f)),
    stale: allowlist.filter((a) => !all.some((f) => f.file === a.file && f.sha256 === a.sha256)),
  };
}
describe('cluster-wide role changes only in serial DB test files (static guard)', () => {
  it('no non-serial *.db.test.ts runs a cluster-wide role change, or SQL the guard cannot read, outside a verified BEGIN … ROLLBACK (reviewed allowlist only; no drift)', () => {
    const scan = repositoryScan();
    expect(walk(SRC).filter((f) => !f.endsWith('.serial.db.test.ts')).length).toBeGreaterThan(20);
    expect(scan.unlisted.map((f) => `${f.file}:${f.line} sha256 ${f.sha256} ${f.problems.join('; ')}`)).toEqual([]);
    expect(scan.stale).toEqual([]);
  }, 60_000);

  it('the allowlist is exact: an entry that matches no finding is stale (drift), and a finding without an entry is reported', () => {
    expect(ALLOWLIST.length).toBe(3);
    const ghost = { file: 'src/ingest/db/commit.db.test.ts', sha256: '0'.repeat(64), reason: 'drifted' };
    const withGhost = repositoryScan([...ALLOWLIST, ghost]);
    expect(withGhost.stale).toEqual([ghost]);
    const withoutFirst = repositoryScan(ALLOWLIST.slice(1));
    expect(withoutFirst.unlisted.map((f) => f.sha256)).toEqual([ALLOWLIST[0].sha256]);
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(40);
  }, 60_000);

  it('the Slice 0/1 files with role DDL (rolled back, database-local or atomic) pass unchanged, non-vacuously', () => {
    for (const f of [
      'src/ingest/db/memberPrivileges.db.test.ts',
      'src/ingest/db/roles.db.test.ts',
      'src/ingest/db/privileges.db.test.ts',
      'src/ingest/db/foundation.db.test.ts',
      'src/ingest/db/immutability.db.test.ts',
      'src/ingest/cli.db.test.ts',
    ]) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const findings = queryFindings(f, code).filter((x) => !ALLOWLIST.some((a) => a.file === x.file && a.sha256 === x.sha256));
      expect(findings, f).toEqual([]);
    }
    // Not vacuous: these files DO run SQL inside BEGIN … ROLLBACK, recognised by the strict rules.
    // (roles.db.test.ts: runUpAfter's `c.query(pre)` and `c.query(upSql)`, BEGIN in an outer try, ROLLBACK first in its finally.)
    for (const [f, min] of [
      ['src/ingest/db/memberPrivileges.db.test.ts', 6],
      ['src/ingest/db/privileges.db.test.ts', 6],
      ['src/ingest/db/roles.db.test.ts', 2],
    ] as const) {
      expect(rolledBackQueries(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), f).toBeGreaterThanOrEqual(min);
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
    expect(v('async function f() { const c = await db.pool.connect(); await c.query(`GRANT ratio_worker TO ${x}`); }')).toHaveLength(1);
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); await c.query(`GRANT ratio_worker TO ${x}`); await c.query('COMMIT'); }")).toHaveLength(1);
    // Flagged: a pool call inside a function that rolls back ITS client (the pool statement still autocommits).
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); try { await db.pool.query(`GRANT ratio_worker TO ${x}`); } finally { await c.query('ROLLBACK'); } }")).toHaveLength(1);
    // Not flagged: inside BEGIN … ROLLBACK, directly or through a helper of the file.
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); try { await c.query(`GRANT ratio_worker TO ${x}`); } finally { await c.query('ROLLBACK'); } }")).toEqual([]);
    expect(
      v("async function inTxn(fn) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }\nit('t', async () => { await inTxn(async (c) => { await c.query(`GRANT ${a} TO ${b}`); }); });"),
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

// --- Copilot review of f684dbc: 4176494757 (High) and 4176494775 (High) -----
// "BEGIN and ROLLBACK somewhere in the function" is not proof, and a raw-text
// prefilter skips SQL that the AST would rebuild. Each bypass shape must be
// flagged; unresolvable SQL outside a verified rolled-back transaction too.
describe('guard soundness (Copilot 4176494757, 4176494775)', () => {
  const v = (code: string) => parallelRoleDdlViolations('x.db.test.ts', code);
  const GRANT = 'await c.query(`GRANT ratio_worker TO ${x}`);';

  it('bypass 1: BEGIN and ROLLBACK on a DIFFERENT client than the GRANT ⇒ flagged', () => {
    expect(v("async function f() { const c = await db.pool.connect(); const d = await db.pool.connect(); await d.query('BEGIN'); try { " + GRANT + " } finally { await d.query('ROLLBACK'); } }")).not.toEqual([]);
  });

  it('bypass 2: ROLLBACK BEFORE the GRANT ⇒ flagged', () => {
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); await c.query('ROLLBACK'); " + GRANT + ' }')).not.toEqual([]);
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); try { await c.query('ROLLBACK'); " + GRANT + " } finally { await c.query('ROLLBACK'); } }")).not.toEqual([]);
  });

  it('bypass 3: the GRANT in an unused NESTED function of a function that BEGINs and ROLLBACKs ⇒ flagged', () => {
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); const g = async () => { " + GRANT + " }; await c.query('ROLLBACK'); return g; }")).not.toEqual([]);
  });

  it('bypass 4: a CONDITIONAL BEGIN or a CONDITIONAL ROLLBACK ⇒ flagged', () => {
    expect(v("async function f(t) { const c = await db.pool.connect(); if (t) await c.query('BEGIN'); try { " + GRANT + " } finally { await c.query('ROLLBACK'); } }")).not.toEqual([]);
    expect(v("async function f(t) { const c = await db.pool.connect(); await c.query('BEGIN'); try { " + GRANT + " } finally { if (t) await c.query('ROLLBACK'); } }")).not.toEqual([]);
  });

  it('straight-line: an early exit, a COMMIT or no ROLLBACK after the GRANT ⇒ flagged; plain BEGIN; GRANT; ROLLBACK passes', () => {
    expect(v("async function f(t) { const c = await db.pool.connect(); await c.query('BEGIN'); " + GRANT + " if (t) return; await c.query('ROLLBACK'); }")).not.toEqual([]);
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); " + GRANT + " await c.query('COMMIT'); await c.query('ROLLBACK'); }")).not.toEqual([]);
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); " + GRANT + ' }')).not.toEqual([]);
    expect(v("async function f() { const c = await db.pool.connect(); await c.query('BEGIN'); " + GRANT + " await c.query('ROLLBACK'); }")).toEqual([]);
    // BEGIN in an outer try, the finally rolls back (Slice 0 roles.db.test.ts shape).
    expect(v("async function f(p) { const c = await db.pool.connect(); try { await c.query('BEGIN'); if (p) " + GRANT + " } finally { await c.query('ROLLBACK').catch(() => undefined); } }")).toEqual([]);
  });

  it('helpers: the helper itself must BEGIN, call the callback with THAT client inside the transaction, and ROLLBACK unconditionally', () => {
    const use = "\nit('t', async () => { await h(async (k) => { await k.query(`GRANT ratio_worker TO ${x}`); }); });";
    expect(v("async function h(fn) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }" + use)).toEqual([]);
    // A different client is passed to the callback.
    expect(v("async function h(fn) { const c = await db.pool.connect(); const d = await db.pool.connect(); await c.query('BEGIN'); try { await fn(d); } finally { await c.query('ROLLBACK'); } }" + use)).not.toEqual([]);
    // The callback runs after the ROLLBACK.
    expect(v("async function h(fn) { const c = await db.pool.connect(); await c.query('BEGIN'); await c.query('ROLLBACK'); await fn(c); }" + use)).not.toEqual([]);
    // The ROLLBACK is conditional.
    expect(v("async function h(fn, t) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await fn(c); } finally { if (t) await c.query('ROLLBACK'); } }" + use)).not.toEqual([]);
    // The callback ends the transaction itself before the GRANT.
    expect(
      v("async function h(fn) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }\nit('t', async () => { await h(async (k) => { await k.query('COMMIT'); await k.query(`GRANT ratio_worker TO ${x}`); }); });"),
    ).not.toEqual([]);
  });

  it('SQL the AST can rebuild is checked even when the raw text has no keyword: concatenation ⇒ flagged', () => {
    expect(v("await db.pool.query('GR' + 'ANT ratio_worker TO x');")).not.toEqual([]);
    expect(v("await db.pool.query('ALT' + 'ER ROLE x NOLOGIN');")).not.toEqual([]);
  });

  it('unresolvable SQL outside a verified rolled-back transaction ⇒ flagged: a bare variable, a call, a statement-position hole', () => {
    expect(v('async function f(sql) { await db.pool.query(sql); }')).not.toEqual([]);
    expect(v('await db.pool.query(buildSql());')).not.toEqual([]);
    expect(v('await db.pool.query(`${stmt}`);')).not.toEqual([]);
    expect(v("await db.pool.query(`DO $$ BEGIN EXECUTE format('${s}', current_database()); END $$`);")).not.toEqual([]);
    expect(v('await db.pool.query({ text: q, values: [] });')).not.toEqual([]);
  });

  it('resolvable SQL is judged by its text: a const literal, a for-of over literals, value-position holes', () => {
    expect(v("const SQL = 'SELECT 1'; await db.pool.query(SQL);")).toEqual([]);
    expect(v("const G = 'GRANT ratio_worker TO x'; await db.pool.query(G);")).not.toEqual([]);
    expect(v("for (const s of ['SELECT 1', 'SELECT 2']) await db.pool.query(s);")).toEqual([]);
    expect(v("for (const s of ['SELECT 1', 'REVOKE ratio_worker FROM x']) await db.pool.query(s);")).not.toEqual([]);
    expect(v('await db.pool.query(`SELECT * FROM t WHERE id = ${id}`, []);')).toEqual([]);
    // Inside a verified rolled-back transaction, unresolvable SQL is fine.
    expect(v("async function f(sql) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await c.query(sql); } finally { await c.query('ROLLBACK'); } }")).toEqual([]);
  });
});

// --- challenger Low on 480dd87: guard hardening ---------------------------------
describe('guard hardening (challenger Low on 480dd87)', () => {
  const v = (code: string) => parallelRoleDdlViolations('x.db.test.ts', code);
  const TXN = (decl: string) =>
    `async function f() { ${decl} await c.query('BEGIN'); try { await c.query(\`GRANT ratio_worker TO \${x}\`); } finally { await c.query('ROLLBACK'); } }`;

  it('(a) only a client that provably comes from `await x.connect()`, `new Client` (pg) or a local function returning one is transaction-capable', () => {
    // A pool, or anything else, under a client-like name: autocommit ⇒ flagged.
    expect(v(TXN('const c = db.pool;'))).not.toEqual([]);
    expect(v(TXN('const c = db.admin;'))).not.toEqual([]);
    expect(v(TXN('const c = getThing();'))).not.toEqual([]);
    expect(v(TXN('let c = await db.pool.connect();'))).not.toEqual([]);
    expect(v("import { Client } from './fake';\n" + TXN('const c = new Client({});'))).not.toEqual([]);
    // Provable clients pass.
    expect(v(TXN('const c = await db.pool.connect();'))).toEqual([]);
    expect(v("import { Client } from 'pg';\n" + TXN('const c = new Client({});'))).toEqual([]);
    expect(
      v("import { Client } from 'pg';\nasync function connect(d) { const k = new Client({ connectionString: d }); await k.connect(); return k; }\n" + TXN('const c = await connect(db);')),
    ).toEqual([]);
    // A local function that returns something else is not a client source.
    expect(v('async function connect(d) { return d.pool; }\n' + TXN('const c = await connect(db);'))).not.toEqual([]);
    // A helper must itself use a provable client for its callback.
    expect(
      v("async function h(fn) { const c = db.pool; await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }\nit('t', async () => { await h(async (k) => { await k.query(`GRANT ratio_worker TO ${x}`); }); });"),
    ).not.toEqual([]);
  });

  it('(b) CREATE ROLE … ROLE / ADMIN / USER <existing> adds members: a role change; plain CREATE ROLE … IN ROLE stays accepted', () => {
    expect(v("await db.pool.query('CREATE ROLE x LOGIN ROLE ratio_worker');")).not.toEqual([]);
    expect(v("await db.pool.query('CREATE ROLE x NOLOGIN ADMIN some_login');")).not.toEqual([]);
    expect(v("await db.pool.query('CREATE ROLE x USER some_login');")).not.toEqual([]);
    expect(v("await db.pool.query('CREATE GROUP g USER some_login');")).not.toEqual([]);
    expect(v('await db.pool.query(`CREATE ROLE ${n} LOGIN IN ROLE ratio_reader`);')).toEqual([]);
    expect(v('await db.pool.query(`CREATE ROLE ${n} LOGIN IN GROUP ratio_reader`);')).toEqual([]);
  });

  it('(c) SQL comments are stripped before matching (outside string literals)', () => {
    expect(v("await db.pool.query('GRANT/**/ratio_worker TO x');")).not.toEqual([]);
    expect(v("await db.pool.query('GRANT ratio_worker /* ON DATABASE d */ TO x');")).not.toEqual([]);
    expect(v("await db.pool.query('ALTER--c\\nROLE x NOLOGIN');")).not.toEqual([]);
    expect(v("await db.pool.query('REVOKE /* ON TABLE t */ ratio_worker FROM x');")).not.toEqual([]);
    // A '--' inside a string literal is text, not a comment: the GRANT after it still counts.
    expect(v("await db.pool.query(\"SELECT '--'; GRANT ratio_worker TO x\");")).not.toEqual([]);
  });

  it('(d) any indirect use of query is flagged: .call, .apply, .bind, destructuring, a computed member', () => {
    expect(v("await c.query.call(c, 'SELECT 1');")).not.toEqual([]);
    expect(v("await c.query.apply(c, ['SELECT 1']);")).not.toEqual([]);
    expect(v('const q = db.pool.query.bind(db.pool);')).not.toEqual([]);
    expect(v('const { query } = db.pool;')).not.toEqual([]);
    expect(v('const { query: run } = db.pool;')).not.toEqual([]);
    expect(v("await db.pool['query']('GRANT ratio_worker TO x');")).not.toEqual([]);
  });

  it('(e) a client reassigned before the call is not the client that BEGAN', () => {
    expect(
      v(
        "async function h(fn) { const c = await db.pool.connect(); await c.query('BEGIN'); try { await fn(c); } finally { await c.query('ROLLBACK'); } }\nit('t', async () => { await h(async (k) => { k = other; await k.query(`GRANT ratio_worker TO ${x}`); }); });",
      ),
    ).not.toEqual([]);
    expect(
      v("async function f(c) { await c.query('BEGIN'); c = await db.pool.connect(); try { await c.query(`GRANT ratio_worker TO ${x}`); } finally { await c.query('ROLLBACK'); } }"),
    ).not.toEqual([]);
  });

  it('the Slice 0/1 files still pass with the same 3-entry allowlist', () => {
    const scan = repositoryScan();
    expect(scan.unlisted).toEqual([]);
    expect(scan.stale).toEqual([]);
    expect(ALLOWLIST).toHaveLength(3);
  }, 60_000);
});
