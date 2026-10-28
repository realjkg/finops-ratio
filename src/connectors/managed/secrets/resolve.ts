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

/** Replaces every occurrence of each secret value (4+ characters) in strings, deep. */
export function scrubSecrets<T>(v: T, secrets: readonly string[]): T {
  const vals = secrets.filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return vals.reduce((acc, s) => acc.split(s).join('[redacted]'), x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object' && !(x instanceof Buffer) && !(x instanceof Date)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}
