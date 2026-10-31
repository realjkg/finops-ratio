// R2 slice E: the operator users command, compiled into dist-worker and run as
// `node dist-worker/ingest/cli.js users <command> [--flag value ...]`.
//   list                                               ids, names, status, role; never a hash
//   add --id --name --role --by [--password-stdin]      user + active membership (+ local credential from stdin)
//   set-role --id --role --by | suspend --id --by | unsuspend --id --by | revoke-sessions --id --by
//   bind --id --connection --subject --by | unbind --connection --subject --by
// Rules: nobody changes their own role, status or bindings (--by must differ
// from --id); a password is read only from stdin, never argv; the result must
// pass validateDirectory or nothing is written; one writer at a time (a .lock
// file) and the file must be unchanged since it was read; the file is rewritten
// IN PLACE (same inode: a single-file bind mount sees it). A concurrent reader
// sees the old file, the new file, or a strict prefix of it (invalid JSON:
// the app then fails closed for that request). suspend and revoke-sessions
// delete the user's sessions in RATIO_ENGAGEMENT_STATE. One audit line per
// command on stdout: action, target, actor, outcome; no secrets. SERVER-ONLY.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngagementConfig } from '../config';
import { ROLE_PERMISSIONS } from './authz';
import { validateDirectory } from './directory';
import { hashPassword } from './password';
import { EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
type IO = { out(l: string): void; err(l: string): void };
type Doc = { users: Array<Record<string, unknown>>; memberships?: Array<Record<string, unknown>>; localCredentials?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>; identityConnections?: Array<Record<string, unknown>> } & Record<string, unknown>;
class Refused extends Error {}

const FLAGS = new Set(['id', 'name', 'role', 'by', 'connection', 'subject', 'password-stdin']);
function parse(args: string[]): Map<string, string> | null {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const k = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!FLAGS.has(k)) return null; // unknown flags (including --password) are refused
    if (k === 'password-stdin') m.set(k, '1');
    else if (i + 1 < args.length) m.set(k, args[(i += 1)]);
    else return null;
  }
  return m;
}
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function usersMain(argv: string[], env: Env, io: IO, readStdin = () => fs.readFileSync(0, 'utf8'), beforeWrite = () => {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = parse(rest);
  const fail = (code: string, extra: Record<string, unknown> = {}, exit = 1) => { io.err(JSON.stringify({ event: 'users_admin', outcome: 'refused', code, ...extra })); return exit; };
  if (!f || !cmd) return fail('users.usage', { message: 'users list | add | set-role | suspend | unsuspend | revoke-sessions | bind | unbind (see src/engagement/auth/usersCli.ts)' }, 2);
  const cfg = loadEngagementConfig(env.RATIO_ENGAGEMENT_CONFIG ?? '');
  const file = env.RATIO_ENGAGEMENT_USERS ?? '';
  if (!cfg.ok) return fail('users.config_invalid', { problems: cfg.problems }, 2);
  if (!path.isAbsolute(file)) return fail('users.file_invalid', { problems: ['RATIO_ENGAGEMENT_USERS: must be an absolute path'] }, 2);
  const instance = { tenantId: cfg.config.tenantId, engagementId: cfg.config.engagementId };
  const read = () => fs.readFileSync(file);
  const parseDoc = (b: Buffer) => JSON.parse(b.subarray(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0).toString('utf8')) as Doc;
  if (cmd === 'list') {
    const d = parseDoc(read());
    const role = (id: unknown) => d.memberships?.find((m) => same(m.userId, id))?.role ?? null;
    io.out(JSON.stringify({ users: d.users.map((u) => ({ id: u.id, displayName: u.displayName, status: u.status, role: role(u.id),
      localCredential: !!d.localCredentials?.some((c) => same(c.userId, u.id)), bindings: d.bindings?.filter((b) => same(b.userId, u.id)).length ?? 0 })) }));
    return 0;
  }
  const id = f.get('id');
  const by = f.get('by');
  if (!by || (cmd !== 'unbind' && !id)) return fail('users.usage', { message: '--by (and --id) are required' }, 2);
  if (id && same(id, by) && cmd !== 'add') return fail('users.self_change_refused');
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { return fail('users.locked'); }
  try {
    const original = read();
    const doc = parseDoc(original);
    let revoke = false;
    const user = () => doc.users.find((u) => same(u.id, id));
    const member = () => doc.memberships?.find((m) => same(m.userId, id));
    if (cmd === 'add') {
      const role = f.get('role');
      if (!role || !Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Refused('users.role_invalid');
      doc.users.push({ id, displayName: f.get('name') ?? '', status: 'active' });
      (doc.memberships ??= []).push({ userId: id, ...instance, role, status: 'active' });
      if (f.has('password-stdin')) {
        const pwd = readStdin().split(/\r?\n/)[0];
        let passwordHash: string;
        try { passwordHash = await hashPassword(pwd); } catch { throw new Refused('users.password_invalid'); }
        (doc.localCredentials ??= []).push({ userId: id, passwordHash });
      }
    } else if (cmd === 'set-role') {
      const m = member();
      if (!m) throw new Refused('users.unknown_user');
      m.role = f.get('role');
    } else if (cmd === 'suspend' || cmd === 'unsuspend') {
      const u = user();
      if (!u) throw new Refused('users.unknown_user');
      u.status = cmd === 'suspend' ? 'suspended' : 'active';
      revoke = cmd === 'suspend';
    } else if (cmd === 'revoke-sessions') {
      if (!user()) throw new Refused('users.unknown_user');
      revoke = true;
    } else if (cmd === 'bind') {
      const conn = doc.identityConnections?.find((c) => c.id === f.get('connection'));
      (doc.bindings ??= []).push({ connectionId: f.get('connection'), issuer: conn?.issuer ?? '', subject: f.get('subject'), userId: id, approvedBy: by, approvedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    } else if (cmd === 'unbind') {
      const before = doc.bindings?.length ?? 0;
      doc.bindings = (doc.bindings ?? []).filter((b) => !(b.connectionId === f.get('connection') && b.subject === f.get('subject')));
      if (doc.bindings.length === before) throw new Refused('users.unknown_binding');
    } else return fail('users.usage', { message: `unknown command ${JSON.stringify(cmd).slice(0, 40)}` }, 2);
    const v = validateDirectory(doc, instance);
    if (!v.ok) throw new Refused('users.invalid_result', { cause: v.problems });
    const next = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    beforeWrite();
    const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    if (digest(read()) !== digest(original)) throw new Refused('users.changed_concurrently');
    if (cmd !== 'revoke-sessions') {
      const w = fs.openSync(file, 'r+'); // in place: same inode
      try { fs.ftruncateSync(w, 0); fs.writeSync(w, next, 0, next.length, 0); fs.fsyncSync(w); } finally { fs.closeSync(w); }
    }
    let sessionsRevoked: number | undefined;
    if (revoke) {
      const state = env.RATIO_ENGAGEMENT_STATE ?? '';
      if (!path.isAbsolute(state)) throw new Refused('users.state_missing');
      const store = new EngagementSessionStore(state);
      try { sessionsRevoked = store.revokeUser(user()!.id as string); } finally { store.close(); }
    }
    io.out(JSON.stringify({ event: 'users_admin', action: cmd, target: id ?? null, actor: by, outcome: 'success', ...(sessionsRevoked !== undefined ? { sessionsRevoked } : {}) }));
    return 0;
  } catch (e) {
    if (e instanceof Refused) return fail(e.message, e.cause ? { problems: e.cause } : {});
    return fail('users.failed');
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
