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

/** Removes the connection URL and its credentials from any text we might print. */
function redactor(url: string | undefined): (s: string) => string {
  const secrets: string[] = [];
  if (url) {
    secrets.push(url);
    try {
      const u = new URL(url);
      if (u.password) secrets.push(u.password, decodeURIComponent(u.password));
      if (u.username && u.username.length >= 3) secrets.push(u.username, decodeURIComponent(u.username));
    } catch {
      // unparseable URL: only the literal string is redacted
    }
  }
  return (s: string) => secrets.filter(Boolean).reduce((acc, sec) => acc.split(sec).join('[redacted]'), s);
}

export async function main(argv: string[], env: Env, io: CliIO): Promise<number> {
  const redact = redactor(env.RATIO_MIGRATE_DATABASE_URL);
  const emit = (level: 'info' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
    if (level === 'error') io.err(line);
    else io.out(line);
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
      if (args.json) io.out(redact(JSON.stringify(status)));
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
