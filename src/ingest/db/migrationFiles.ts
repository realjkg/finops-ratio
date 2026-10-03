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
}

/** Shipped migrations, next to this module (also after the worker build copies them). */
export const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const PHASE_RE = /^--\s*ratio:phase\s+(\S+)\s*$/;

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Returns the SQL with comments, string literals, quoted identifiers and
 * dollar-quoted bodies blanked out, leaving only top-level code and `;`.
 */
export function stripNonCode(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  const isIdent = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
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
      out += ' ';
      continue;
    }
    if ((ch === 'E' || ch === 'e') && next === "'" && !isIdent(sql[i - 1])) {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (ch === '$' && !isIdent(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += ' ';
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function statements(sql: string): string[] {
  return stripNonCode(sql)
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0);
}

/** First transaction-control keyword found at statement level, or null. */
export function findTransactionControl(sql: string): string | null {
  for (const stmt of statements(sql)) {
    const words = stmt.toUpperCase().split(' ');
    const first = words[0];
    if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT'].includes(first)) return first;
    if (first === 'START' && words[1] === 'TRANSACTION') return first;
    if (first === 'PREPARE' && words[1] === 'TRANSACTION') return first;
  }
  return null;
}

/**
 * Lexical check that an `expand` migration is additive. Heuristic, not a proof:
 * flags DROP, TRUNCATE, DELETE, RENAME and column type changes.
 */
export function findDestructiveStatement(sql: string): string | null {
  for (const stmt of statements(sql)) {
    const u = stmt.toUpperCase();
    if (/^(DROP|TRUNCATE|DELETE)\b/.test(u)) return stmt;
    if (/^ALTER\b/.test(u)) {
      if (/\bDROP\b/.test(u) || /\bRENAME\b/.test(u) || /\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/.test(u)) return stmt;
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
    if (phase === 'expand') {
      const destructive = findDestructiveStatement(upSql);
      if (destructive) {
        throw new MigrationError(
          'EXPAND_NOT_ADDITIVE',
          `${up.file} is marked expand but contains a destructive statement: ${destructive.slice(0, 80)}`,
        );
      }
    }
    result.push({ version, name: up.name, phase, upSql, downSql, checksum: sha256Hex(bytes) });
  }
  return result;
}
