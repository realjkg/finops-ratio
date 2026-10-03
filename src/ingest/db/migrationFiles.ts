// Migration file discovery and static validation. No database access and no
// `pg` import, so it can be unit-tested in the fast suite.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type MigrationErrorCode =
  | 'BAD_FILENAME'
  | 'DUPLICATE_VERSION'
  | 'ORPHAN_DOWN'
  | 'DIR_MISSING'
  | 'MISSING_PHASE'
  | 'EXPAND_NOT_ADDITIVE'
  | 'FORBIDDEN_STATEMENT'
  | 'TRANSACTION_CONTROL'
  | 'CHECKSUM_MISMATCH'
  | 'MISSING_FILE'
  | 'OUT_OF_ORDER'
  | 'CONTRACT_NOT_ALLOWED'
  | 'DOWN_NOT_ALLOWED'
  | 'NO_DOWN'
  | 'INVALID_STEPS';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export type MigrationPhase = 'expand' | 'contract';

export interface MigrationFile {
  version: string;
  name: string;
  phase: MigrationPhase;
  upSql: string;
  downSql: string | null;
  /** sha256 hex of the raw .up.sql bytes */
  checksum: string;
  /** sha256 hex of the raw .down.sql bytes, or null when there is no down file */
  downChecksum: string | null;
}

/** Shipped migrations, next to this module (also after the worker build copies them). */
export const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const PHASE_RE = /^--\s*ratio:phase\s+(\S+)\s*$/;

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Returns a same-length copy of the SQL in which only top-level code is left
 * intact: comments and the contents of string literals and dollar-quoted
 * bodies become spaces (newlines are kept, so offsets and line numbers still
 * match the original). Quoted identifiers keep their quotes and their
 * identifier characters (anything else becomes `_`), so they stay one token.
 */
export function maskNonCode(sql: string, onDollarBody?: (body: string) => void): string {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const isIdent = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      blank(start, i);
      continue;
    }
    if ((ch === 'E' || ch === 'e') && next === "'" && !isIdent(sql[i - 1])) {
      const start = i + 2;
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      blank(start, i);
      i++;
      continue;
    }
    if (ch === "'") {
      const start = i + 1;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      blank(start, i);
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out[i] = '_';
          out[i + 1] = '_';
          i += 2;
        } else if (sql[i] === '"') break;
        else {
          if (!isIdent(sql[i]) && sql[i] !== '\n') out[i] = '_';
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === '$' && !isIdent(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        if (onDollarBody) onDollarBody(sql.slice(i + tag.length, end === -1 ? n : end));
        // keep a `$ … $` token so the statement still shows a body was here
        blank(i + 1, stop - 1);
        out[i] = '$';
        if (stop - 1 < n && stop - 1 > i) out[stop - 1] = '$';
        i = stop;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

/** Back-compat name used by older call sites/tests. */
export const stripNonCode = maskNonCode;

interface Statement {
  /** upper-cased code with whitespace collapsed */
  norm: string;
  /** offset of the statement's first code character in the original SQL */
  start: number;
}

function splitStatements(sql: string): Statement[] {
  const masked = maskNonCode(sql);
  const result: Statement[] = [];
  let begin = 0;
  const push = (from: number, to: number) => {
    const raw = masked.slice(from, to);
    const norm = raw.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!norm) return;
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    result.push({ norm, start: from + lead });
  };
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      push(begin, i);
      begin = i + 1;
    }
  }
  push(begin, masked.length);
  return result;
}

function statements(sql: string): string[] {
  return splitStatements(sql).map((s) => s.norm);
}

/** First transaction-control keyword found at statement level, or null. */
export function findTransactionControl(sql: string): string | null {
  for (const stmt of statements(sql)) {
    const words = stmt.split(' ');
    const first = words[0];
    if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT'].includes(first)) return first;
    if (first === 'START' && words[1] === 'TRANSACTION') return first;
    if (first === 'PREPARE' && words[1] === 'TRANSACTION') return first;
  }
  return null;
}

/** Splits a comma-separated list at paren depth 0. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

type MarkerKind = 'do' | 'view' | 'function';

/**
 * True when the last non-blank line before the statement is
 * `-- ratio:allow-<kind> <reason>` (a reviewer-visible, reasoned escape hatch).
 */
function hasMarker(sql: string, start: number, kind: MarkerKind): boolean {
  const lines = sql.slice(0, start).split(/\r?\n/);
  lines.pop(); // the (possibly empty) beginning of the statement's own line
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.length > 0 && new RegExp(`^\\s*--\\s*ratio:allow-${kind}\\s+\\S`).test(lines[lines.length - 1]);
}

const IN_RATIO = '"?RATIO"?\\.';

const EXPAND_SIMPLE: RegExp[] = [
  /^CREATE TABLE /,
  /^CREATE (UNIQUE )?INDEX (?!CONCURRENTLY\b)/,
  /^CREATE SCHEMA /,
  /^CREATE POLICY /,
  /^CREATE TYPE /,
  /^CREATE SEQUENCE /,
  /^CREATE VIEW /,
  /^CREATE FUNCTION /,
  /^CREATE (CONSTRAINT )?TRIGGER /,
  /^COMMENT ON /,
  /^SET LOCAL (ROLE|SEARCH_PATH)\b/,
];

const EXPAND_ALTER_TABLE_ACTIONS: RegExp[] = [
  // ADD COLUMN ... NOT NULL additionally needs a DEFAULT (checked in isExpandStatement)
  /^ADD COLUMN /,
  /^ADD CONSTRAINT \S+ .* NOT VALID$/,
  /^VALIDATE CONSTRAINT \S+$/,
  /^(ENABLE|FORCE) ROW LEVEL SECURITY$/,
];

const READ_ONLY_GUARD_FUNCTIONS = /^SELECT PG_CATALOG\.(PG_HAS_ROLE|HAS_[A-Z_]+_PRIVILEGE|CURRENT_SETTING|VERSION) ?\(/;

function isExpandStatement(stmt: Statement, sql: string): boolean {
  const u = stmt.norm;
  // Objects in schema ratio that can change what tenants see or what is
  // enforced need a reasoned marker on the line above (round 3).
  if (new RegExp(`^CREATE VIEW ${IN_RATIO}`).test(u)) return hasMarker(sql, stmt.start, 'view');
  if (new RegExp(`^CREATE FUNCTION ${IN_RATIO}`).test(u)) return hasMarker(sql, stmt.start, 'function');
  if (new RegExp(`^CREATE (CONSTRAINT )?TRIGGER .* ON (ONLY )?${IN_RATIO}`).test(u)) return hasMarker(sql, stmt.start, 'function');
  if (EXPAND_SIMPLE.some((re) => re.test(u))) return true;
  const alter = /^ALTER TABLE (IF EXISTS )?(ONLY )?\S+ (.+)$/.exec(u);
  if (alter) {
    return splitTopLevel(alter[3]).every(
      (action) =>
        EXPAND_ALTER_TABLE_ACTIONS.some((re) => re.test(action)) &&
        // NOT NULL without DEFAULT breaks existing rows and older writers
        !(/^ADD COLUMN /.test(action) && /\bNOT NULL\b/.test(action) && !/\bDEFAULT\b/.test(action)),
    );
  }
  const grant = /^GRANT (.+) ON (.+) TO (.+)$/.exec(u);
  if (grant) {
    const grantees = splitTopLevel(grant[3].replace(/ WITH GRANT OPTION$/, '').replace(/ GRANTED BY .+$/, ''));
    return grantees.length > 0 && grantees.every((g) => /^[A-Z_][A-Z0-9_]*$/.test(g) && g !== 'PUBLIC');
  }
  // Revoking from PUBLIC only narrows: releases never rely on PUBLIC privileges
  // (GRANT ... TO PUBLIC is always forbidden; every privilege a release uses is
  // granted to a named ratio role).
  if (/^REVOKE .+ ON .+ FROM PUBLIC( CASCADE| RESTRICT)?$/.test(u)) return true;
  if (READ_ONLY_GUARD_FUNCTIONS.test(u) && !/ FROM /.test(u)) return true;
  if (/^DO( LANGUAGE \S+)? \$/.test(u) || u === 'DO') return hasMarker(sql, stmt.start, 'do');
  return false;
}

/**
 * `expand` is an ALLOW-LIST: returns the first statement that is not one of
 * the additive forms (see EXPAND_* above), or null when every statement is.
 */
export function findNonExpandStatement(sql: string): string | null {
  for (const stmt of splitStatements(sql)) if (!isExpandStatement(stmt, sql)) return stmt.norm;
  return null;
}

const FORBIDDEN: RegExp[] = [
  /^ALTER TABLE .*\b(DISABLE|NO FORCE) ROW LEVEL SECURITY\b/,
  /^ALTER TABLE .*\bDISABLE TRIGGER\b/,
  /^(DROP|ALTER) POLICY\b/,
  /^(ALTER|CREATE) (ROLE|USER|GROUP)\b.*\b(SUPERUSER|BYPASSRLS|CREATEROLE)\b/,
  /^(CREATE OR REPLACE|ALTER|DROP) FUNCTION (RATIO|"RATIO")\.("?)CURRENT_TENANT_ID\b/,
  /^SET (LOCAL |SESSION )?SESSION_REPLICATION_ROLE\b/,
];

/**
 * Statements refused in ANY migration, even a contract one with
 * --allow-contract: they would disable tenant isolation or escalate roles.
 */
const TENANT_PREDICATES = new Set(['(TENANT_ID=RATIO.CURRENT_TENANT_ID())', '(ID=RATIO.CURRENT_TENANT_ID())']);

/** Text of the balanced parenthesised group starting at `open` (inclusive), or null. */
function parenGroup(u: string, open: number): string | null {
  if (u[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < u.length; i++) {
    if (u[i] === '(') depth++;
    if (u[i] === ')' && --depth === 0) return u.slice(open, i + 1);
  }
  return null;
}

/** A permissive policy must use exactly the tenant predicate in USING and WITH CHECK. */
function isUnsafePolicy(u: string): boolean {
  if (!/^CREATE POLICY /.test(u)) return false;
  if (/ AS RESTRICTIVE\b/.test(u)) return false; // can only narrow access
  const clauses: string[] = [];
  for (const kw of [' USING ', ' WITH CHECK ']) {
    const at = u.indexOf(kw);
    if (at === -1) continue;
    const g = parenGroup(u, at + kw.length);
    if (g === null) return true;
    clauses.push(g.replace(/\s+/g, ''));
  }
  return clauses.length === 0 || clauses.some((c) => !TENANT_PREDICATES.has(c));
}

const unquote = (x: string) => x.replace(/"/g, '');
const READER_GRANTS: Array<[RegExp, RegExp]> = [
  [/^SELECT$/, new RegExp(`^(TABLE )?${IN_RATIO}"?COST_FACTS_PUBLISHED"?$`)],
  [/^EXECUTE$/, new RegExp(`^FUNCTION ${IN_RATIO}"?CURRENT_TENANT_ID"? ?\\( ?\\)$`)],
  [/^USAGE$/, /^SCHEMA "?RATIO"?$/],
];

/** GRANTs that would widen what ratio roles can do beyond the reviewed model. */
function isUnsafeGrant(u: string): boolean {
  if (!/^GRANT /.test(u)) return false;
  const to = u.lastIndexOf(' TO ');
  if (to === -1) return false;
  const grantees = splitTopLevel(u.slice(to + 4).replace(/ WITH (GRANT|ADMIN) OPTION.*$/, '').replace(/ GRANTED BY .+$/, '')).map((g) =>
    unquote(g.replace(/^GROUP /, '')),
  );
  if (grantees.includes('PUBLIC')) return true;
  const toRatioRole = grantees.some((g) => /^RATIO_/.test(g));
  const on = /^GRANT (.+?) ON (.+)$/.exec(u.slice(0, to));
  if (!on) return toRatioRole; // role membership granted to a ratio role
  if (!grantees.includes('RATIO_READER')) return false;
  const privs = splitTopLevel(on[1]);
  return !privs.every((p) => READER_GRANTS.some(([pr, obj]) => pr.test(p) && obj.test(on[2].trim())));
}

const PLPGSQL_LEAD = /^(BEGIN|THEN|ELSE|LOOP|EXECUTE|PERFORM|DECLARE|END IF|END LOOP|ELSIF [^ ]+|IF [^ ]+)\s+/;

/**
 * Statements refused in ANY migration, even a contract one with
 * --allow-contract: they would disable tenant isolation, open policies or
 * widen grants, or escalate roles. Dollar-quoted bodies (DO blocks, function
 * bodies) are scanned too: their statements and every string literal in them
 * (EXECUTE / format() arguments). Lexical defence in depth — review is the
 * primary control.
 */
export function findForbiddenStatement(sql: string, depth = 0): string | null {
  const bodies: string[] = [];
  const masked = maskNonCode(sql, (b) => bodies.push(b));
  void masked;
  for (const { norm } of splitStatements(sql)) {
    let u = norm;
    for (let guard = 0; guard < 8 && depth > 0 && PLPGSQL_LEAD.test(u); guard++) u = u.replace(PLPGSQL_LEAD, '');
    if (FORBIDDEN.some((re) => re.test(u))) return u;
    if (isUnsafeGrant(u) || isUnsafePolicy(u)) return u;
    if (/^ALTER DEFAULT PRIVILEGES\b.*\bGRANT\b.*\bTO\b.*\b(PUBLIC|"?RATIO_READER"?)\b/.test(u)) return u;
  }
  if (depth < 3) {
    for (const body of bodies) {
      const inner = findForbiddenStatement(body, depth + 1);
      if (inner) return inner;
      for (const m of body.matchAll(/[Ee]?'((?:[^']|'')*)'/g)) {
        const lit = m[1].replace(/''/g, "'");
        const hit = findForbiddenStatement(lit, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function readPhase(file: string, sql: string): MigrationPhase {
  const phases: string[] = [];
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break; // header block ends at the first code line
    const m = PHASE_RE.exec(line);
    if (m) phases.push(m[1]);
  }
  if (phases.length !== 1 || (phases[0] !== 'expand' && phases[0] !== 'contract')) {
    throw new MigrationError(
      'MISSING_PHASE',
      `${file} must declare exactly one "-- ratio:phase expand|contract" in its leading comment block`,
    );
  }
  return phases[0];
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new MigrationError('DIR_MISSING', `migrations directory not found: ${dir}`);
  }
  const ups = new Map<string, { name: string; file: string }>();
  const downs = new Map<string, { name: string; file: string }>();
  for (const file of fs.readdirSync(dir).sort()) {
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError('BAD_FILENAME', `unexpected file in migrations directory: ${file}`);
    const [, version, name, direction] = m;
    const target = direction === 'up' ? ups : downs;
    if (target.has(version)) throw new MigrationError('DUPLICATE_VERSION', `two ${direction} migrations for version ${version}`);
    target.set(version, { name, file });
  }
  for (const [version, d] of downs) {
    const up = ups.get(version);
    if (!up || up.name !== d.name) throw new MigrationError('ORPHAN_DOWN', `${d.file} has no matching up migration`);
  }
  const result: MigrationFile[] = [];
  for (const version of [...ups.keys()].sort()) {
    const up = ups.get(version)!;
    const bytes = fs.readFileSync(path.join(dir, up.file));
    const upSql = bytes.toString('utf8');
    const down = downs.get(version);
    const downSql = down ? fs.readFileSync(path.join(dir, down.file), 'utf8') : null;
    const phase = readPhase(up.file, upSql);
    for (const [f, sql] of [[up.file, upSql], [down?.file, downSql]] as const) {
      if (sql === null || f === undefined) continue;
      const tc = findTransactionControl(sql);
      if (tc) throw new MigrationError('TRANSACTION_CONTROL', `${f} contains a ${tc} statement; the runner owns transactions`);
    }
    const forbidden = findForbiddenStatement(upSql);
    if (forbidden) {
      throw new MigrationError('FORBIDDEN_STATEMENT', `${up.file} contains a statement that is never allowed: ${forbidden.slice(0, 80)}`);
    }
    if (phase === 'expand') {
      const nonExpand = findNonExpandStatement(upSql);
      if (nonExpand) {
        throw new MigrationError(
          'EXPAND_NOT_ADDITIVE',
          `${up.file} is marked expand but contains a statement outside the expand allow-list: ${nonExpand.slice(0, 80)}`,
        );
      }
    }
    const downBytes = down ? fs.readFileSync(path.join(dir, down.file)) : null;
    result.push({
      version,
      name: up.name,
      phase,
      upSql,
      downSql,
      checksum: sha256Hex(bytes),
      downChecksum: downBytes ? sha256Hex(downBytes) : null,
    });
  }
  return result;
}
