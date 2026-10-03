// Ratio ingestion worker CLI. Slice 0 provides only the `migrate` command.
//
//   migrate                     apply pending migrations (expand only)
//   migrate --allow-contract    also apply pending contract migrations
//   migrate --down N            revert N migrations (dev/test only; needs
//                               RATIO_ALLOW_DOWN_MIGRATIONS=1, refused when
//                               NODE_ENV or RATIO_ENV is production)
//   migrate --status [--json]   read-only status; exit 0 = DB matches code,
//                               3 = mismatch, 1 = error
//
// Connection: RATIO_MIGRATE_DATABASE_URL (a login that is ratio_owner or a
// member of it). The URL and its credentials are never logged.
import { Client } from 'pg';
import { MigrationError } from './db/migrationFiles';
import { assertDownAllowed, migrateDown, migrateUp, migrationStatus } from './db/migrate';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

type Env = Record<string, string | undefined>;

const USAGE = 'usage: cli migrate [--status [--json] | --down N | --allow-contract]';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_STATUS_MISMATCH = 3;

interface MigrateArgs {
  status: boolean;
  json: boolean;
  down: number | null;
  allowContract: boolean;
}

function parseMigrateArgs(args: string[]): MigrateArgs | string {
  const parsed: MigrateArgs = { status: false, json: false, down: null, allowContract: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--status') parsed.status = true;
    else if (a === '--json') parsed.json = true;
    else if (a === '--allow-contract') parsed.allowContract = true;
    else if (a === '--down') {
      const v = args[++i];
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) return '--down requires a positive integer';
      parsed.down = Number(v);
    } else return `unknown argument: ${a}`;
  }
  const modes = [parsed.status, parsed.down !== null].filter(Boolean).length;
  if (modes > 1) return '--status and --down are mutually exclusive';
  if (parsed.json && !parsed.status) return '--json is only valid with --status';
  if (parsed.allowContract && (parsed.status || parsed.down !== null)) return '--allow-contract is only valid when applying';
  return parsed;
}

const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Raw configured secrets (URL, userinfo, password parameters) found in the connection string. */
function configuredSecrets(url: string | undefined): string[] {
  const secrets: string[] = [];
  if (!url) return secrets;
  secrets.push(url);
  try {
    const u = new URL(url);
    if (u.password) secrets.push(u.password, safeDecode(u.password));
    if (u.username && u.username.length >= 3) secrets.push(u.username, safeDecode(u.username));
    for (const [k, v] of u.searchParams) if (/pass/i.test(k) && v) secrets.push(v, encodeURIComponent(v));
  } catch {
    // not a URL (e.g. keyword DSN): handled below
  }
  for (const m of url.matchAll(/(?:^|[\s?&;])[a-z_]*pass[a-z_]*\s*=\s*(?:'((?:[^'\\]|\\.)*)'|([^\s&;]+))/gi)) {
    const v = m[1] ?? m[2];
    if (v) secrets.push(v, safeDecode(v));
  }
  return secrets;
}

/**
 * Every form a secret can take in our output: raw, URL-decoded, URL-encoded,
 * and the JSON-escaped form of each (what JSON.stringify makes of a quote,
 * backslash, newline or control character inside it).
 */
function secretForms(raw: string[]): string[] {
  const forms = new Set<string>();
  for (const s of raw) {
    for (const v of [s, safeDecode(s), encodeURIComponent(s)]) {
      forms.add(v);
      forms.add(JSON.stringify(v).slice(1, -1));
    }
  }
  return [...forms].filter((x) => x.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Removes the connection string and its credentials from any text we might
 * print: the literal URL, URL userinfo, `password=` in a URL query string or
 * a keyword DSN (quoted or not), in raw, URL-decoded, URL-encoded and
 * JSON-escaped form — and, independent of the configured URL, any
 * `password=<value>` appearing in the text.
 */
export function redactor(url: string | undefined): (s: string) => string {
  const forms = secretForms(configuredSecrets(url));
  return (s: string) => {
    let out = forms.reduce((acc, sec) => acc.split(sec).join('[redacted]'), s);
    out = out.replace(/(password\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s&;"]+)/gi, '$1[redacted]');
    return out;
  };
}

/**
 * Deep copy of `value` with `redact` applied to every string (and object
 * key), walking plain objects, arrays and Errors (message, code, cause).
 * Runs BEFORE serialization so escaping can never hide a secret from it.
 */
export function redactDeep(value: unknown, redact: (s: string) => string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, seen));
  if (value instanceof Date) return value.toISOString();
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return redactDeep((toJSON as () => unknown).call(value), redact, seen);
  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; cause?: unknown };
    const out: Record<string, unknown> = { name: e.name, message: redact(e.message) };
    if (e.code !== undefined) out.code = redactDeep(e.code, redact, seen);
    if (e.cause !== undefined) out.cause = redactDeep(e.cause, redact, seen);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, redact, seen);
  return out;
}

/**
 * The ONE way the CLI turns a value into an output line: redact every string
 * before JSON.stringify, then a final pass over the serialized text as a
 * backstop (the forms list includes JSON-escaped secrets).
 */
export function jsonLineRedactor(url: string | undefined): (value: unknown) => string {
  const redact = redactor(url);
  return (value: unknown) => redact(JSON.stringify(redactDeep(value, redact)));
}

export async function main(argv: string[], env: Env, io: CliIO): Promise<number> {
  const line = jsonLineRedactor(env.RATIO_MIGRATE_DATABASE_URL);
  const emit = (level: 'info' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    const text = line({ ts: new Date().toISOString(), level, event, ...fields });
    if (level === 'error') io.err(text);
    else io.out(text);
  };

  const [command, ...rest] = argv;
  if (command !== 'migrate') {
    emit('error', 'cli.usage', { message: USAGE });
    return EXIT_USAGE;
  }
  const args = parseMigrateArgs(rest);
  if (typeof args === 'string') {
    emit('error', 'cli.usage', { message: `${args}; ${USAGE}` });
    return EXIT_USAGE;
  }

  try {
    if (args.down !== null) assertDownAllowed(env); // refuse before connecting
  } catch (e) {
    emit('error', 'migrate.refused', { code: (e as MigrationError).code, message: (e as Error).message });
    return EXIT_ERROR;
  }

  const url = env.RATIO_MIGRATE_DATABASE_URL;
  if (!url) {
    emit('error', 'migrate.config', { message: 'RATIO_MIGRATE_DATABASE_URL is not set' });
    return EXIT_ERROR;
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: 'ratio-migrate' });
  // An idle-connection error must not crash the process with an unredacted stack.
  client.on('error', () => undefined);
  try {
    await client.connect();
    if (args.status) {
      const status = await migrationStatus(client);
      if (args.json) io.out(line(status));
      else emit('info', 'migrate.status', { ...status });
      return status.matches ? EXIT_OK : EXIT_STATUS_MISMATCH;
    }
    const log = (event: string, fields?: Record<string, unknown>) => emit('info', event, fields);
    if (args.down !== null) {
      const res = await migrateDown(client, { steps: args.down, env, log });
      emit('info', 'migrate.done', { reverted: res.reverted });
      return EXIT_OK;
    }
    const res = await migrateUp(client, { allowContract: args.allowContract, log });
    emit('info', 'migrate.done', { applied: res.applied });
    return EXIT_OK;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    emit('error', 'migrate.failed', { code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
    return EXIT_ERROR;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2), process.env, {
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  }).then((code) => {
    process.exitCode = code;
  });
}
