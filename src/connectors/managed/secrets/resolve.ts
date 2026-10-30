// M0a: connector credentials by NAME. A config carries `secretRef` (a name,
// validated by R1); the worker resolves it at run time from
// RATIO_SECRETS_DIR/<name> only: a read-only mount, one file per secret,
// mode 0600 or stricter, at most 64 KiB. Never from the process env, never
// from the config. The value lives only in memory inside a SecretValue, which
// never serializes; errors name the ref, never the value.
import fs from 'fs';
import path from 'path';

export const MAX_SECRET_BYTES = 64 * 1024;
const REF_RE = /^[A-Za-z_][A-Za-z0-9_./-]{0,127}$/;
const MASK = '[secret]';

export type SecretErrorCode = 'SECRETS_DIR_UNSET' | 'SECRET_REF_INVALID' | 'SECRET_MISSING' | 'SECRET_NOT_FILE' | 'SECRET_PERMISSIONS' | 'SECRET_TOO_LARGE' | 'SECRET_EMPTY';

export class SecretError extends Error {
  constructor(readonly code: SecretErrorCode, message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export class SecretValue {
  readonly #value: string;
  constructor(readonly ref: string, value: string) {
    this.#value = value;
  }
  /** The value, for building a request header or signature in memory only. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return MASK;
  }
  toJSON(): string {
    return MASK;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretValue(${this.ref})`;
  }
}

function validRef(ref: string): boolean {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.endsWith('/') && ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function resolveSecret(ref: string, env: { RATIO_SECRETS_DIR?: string }): SecretValue {
  const dir = env.RATIO_SECRETS_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new SecretError('SECRETS_DIR_UNSET', 'RATIO_SECRETS_DIR must be set to the absolute path of the secrets mount');
  if (!validRef(ref)) throw new SecretError('SECRET_REF_INVALID', 'secretRef is not a valid secret name');
  let real: string;
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
    real = fs.realpathSync(path.join(dir, ref));
  } catch {
    throw new SecretError('SECRET_MISSING', `secret ${ref} is missing from the secrets mount`);
  }
  if (!real.startsWith(realDir + path.sep)) throw new SecretError('SECRET_REF_INVALID', `secret ${ref} resolves outside the secrets mount`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new SecretError('SECRET_NOT_FILE', `secret ${ref} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new SecretError('SECRET_PERMISSIONS', `secret ${ref} is readable by group or others (mode must be 0600 or stricter)`);
  if (st.size > MAX_SECRET_BYTES) throw new SecretError('SECRET_TOO_LARGE', `secret ${ref} is larger than ${MAX_SECRET_BYTES} bytes`);
  const value = fs.readFileSync(real, 'utf8').replace(/\r?\n$/, '');
  if (value === '') throw new SecretError('SECRET_EMPTY', `secret ${ref} is empty`);
  return new SecretValue(ref, value);
}

/**
 * Every string worth scrubbing for one secret value: the value itself and, for a structured secret
 * file, each component an error or identity could echo on its own: every string field of a JSON
 * secret (and each line of a multi-line one, e.g. a PEM body), the values of `key=value;...` pairs
 * (never the key names), and the parts of `id:secret`.
 */
export function secretScrubTargets(value: string): string[] {
  const out = new Set<string>([value]);
  const lines = (s: string) => {
    for (const l of s.split(/\r?\n/)) {
      const t = l.trim();
      if (t && !/^-----(BEGIN|END) /.test(t)) out.add(t);
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const walk = (x: unknown): void => {
      if (typeof x === 'string') {
        out.add(x);
        lines(x);
      } else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    walk(parsed);
  } else {
    lines(value);
    for (const l of value.split(/\r?\n/)) {
      if (l.includes('=')) {
        for (const pair of l.split(/[;&]/)) {
          const i = pair.indexOf('=');
          if (i >= 0) out.add(pair.slice(i + 1).trim());
        }
      } else if (l.includes(':')) for (const part of l.split(':')) out.add(part.trim());
    }
  }
  return [...out].filter((s) => s.length >= 4);
}

/** The value and the encoded forms it can take in a URL or a JSON string. */
function encodedForms(s: string): string[] {
  const forms = new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
  return [...forms];
}

/** Replaces every occurrence of each secret value (4+ characters, also URL-encoded or JSON-escaped) in strings and object keys, deep. */
export function scrubSecrets<T>(v: T, secrets: readonly string[]): T {
  const vals = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4).flatMap(encodedForms))].sort((a, b) => b.length - a.length);
  const str = (x: string) => vals.reduce((acc, s) => acc.split(s).join('[redacted]'), x);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return str(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object' && !(x instanceof Buffer) && !(x instanceof Date)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [str(k), walk(y)]));
    return x;
  };
  return walk(v) as T;
}
