// R2 slice E: the operator users command, compiled into dist-worker and run as
// `node dist-worker/ingest/cli.js users <command> [--flag value ...]` (compose: the `users` job, as the app's uid 1000).
// Commands: list | add | set-role | set-password | suspend | unsuspend | revoke-sessions | bind | unbind.
// --by is NOT authentication: it is an audit label the operator types. It must be the literal `operator` or the exact
// id of an ACTIVE tenant_admin, and nobody acts on themselves (add, role, password, status, bindings). Whoever can run
// this job controls the directory; protect the host accordingly.
// Passwords: --password-stdin only; pipe the password, never type it at a terminal (echo). First line only.
// Writes are crash-atomic: users.json lives in its own directory (mounted as a directory); the new content goes to a
// temp file there, fsync, rename over users.json, fsync the directory. One writer at a time: the lock file
// `.users.lock` in the same directory (pid + time; older than 10 minutes is reported as stale, to be removed by hand).
// Nothing is written unless the result passes validateDirectory and fits 512 KiB, or if the file changed since it was
// read. Session revocation (suspend, revoke-sessions, unbind) opens the store before writing; a revocation that fails
// after the write is audited as `partial`. One audit line per command: stdout on success or partial, stderr on refusal.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngagementConfig } from '../config';
import { ROLE_PERMISSIONS } from './authz';
import { validateDirectory } from './directory';
import { hashPassword } from './password';
import { EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
type IO = { out(l: string): void; err(l: string): void };
type Rec = Record<string, unknown>;
type Doc = { users: Rec[]; memberships?: Rec[]; localCredentials?: Rec[]; bindings?: Rec[]; identityConnections?: Rec[] } & Rec;
export interface UsersDeps { readStdin?: () => string; beforeWrite?: () => void; writeSync?: typeof fs.writeSync; revoke?: (store: EngagementSessionStore, userId: string) => number;
  fsyncDir?: (fd: number) => void; maxBytes?: number }
const COMMANDS = new Set(['add', 'set-role', 'set-password', 'suspend', 'unsuspend', 'revoke-sessions', 'bind', 'unbind']);
class Refused extends Error {
  constructor(code: string, readonly extra: Rec = {}) { super(code); }
}

export const USAGE = 'users list | add --id --name --role --by [--password-stdin] | set-role --id --role --by [--force] | set-password --id --by --password-stdin '
  + '| suspend --id --by [--force] | unsuspend --id --by | revoke-sessions --id --by | bind --id --connection --subject --by | unbind --connection --subject --by. '
  + '--by is an audit label (`operator` or an active tenant_admin), not authentication. Pipe passwords on stdin; never type them.';
const FLAGS = new Set(['id', 'name', 'role', 'by', 'connection', 'subject', 'password-stdin', 'force']);
const BOOL = new Set(['password-stdin', 'force']);
const LOCK = '.users.lock';
const STALE_MS = 10 * 60_000;
const MAX_BYTES = 512 * 1024;

function parse(args: string[]): Map<string, string> | null {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const k = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!FLAGS.has(k)) return null; // unknown flags (including --password) are refused
    if (BOOL.has(k)) m.set(k, '1');
    else if (i + 1 < args.length) m.set(k, args[(i += 1)]);
    else return null;
  }
  return m;
}
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const parseDoc = (b: Buffer) => JSON.parse(b.subarray(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0).toString('utf8')) as Doc;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function lock(dir: string): () => void {
  const file = path.join(dir, LOCK);
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Refused('users.lock_failed', { cause: (e as NodeJS.ErrnoException).code ?? 'unknown' });
    let age = 0;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* removed meanwhile */ }
    throw new Refused(age > STALE_MS ? 'users.lock_stale' : 'users.locked', age > STALE_MS ? { recovery: `no users command running? then delete ${LOCK} in the users directory` } : {});
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.closeSync(fd);
  return () => fs.rmSync(file, { force: true });
}

/** Temp file in the same directory, written to completion, fsync, rename over the target, fsync the directory. */
/** Removes temp files a crashed job left behind (older than the stale-lock age); called under the lock. */
function sweep(dir: string): void {
  for (const n of fs.readdirSync(dir)) {
    if (!/^\.users\.json\.\d+\.[0-9a-f]+\.tmp$/.test(n)) continue;
    try { if (Date.now() - fs.statSync(path.join(dir, n)).mtimeMs > STALE_MS) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* raced */ }
  }
}

/** Returns true when everything is durable, 'dir' when only the directory fsync after the rename failed. */
function writeAtomic(file: string, data: Buffer, deps: UsersDeps): true | 'dir' {
  const dir = path.dirname(file);
  const st = fs.statSync(file);
  const tmp = path.join(dir, `.users.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', st.mode & 0o777);
  try {
    try {
      fs.fchmodSync(fd, st.mode & 0o777); // the umask must not narrow the original mode
      for (let off = 0; off < data.length;) off += (deps.writeSync ?? fs.writeSync)(fd, data, off, data.length - off, off);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (process.getuid?.() === 0) fs.chownSync(tmp, st.uid, st.gid); // keep the owner when run as root
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const d = fs.openSync(dir, 'r');
    try { (deps.fsyncDir ?? fs.fsyncSync)(d); } finally { fs.closeSync(d); }
  } catch {
    return 'dir'; // renamed and visible, durability of the rename not confirmed
  }
  return true;
}

export async function usersMain(argv: string[], env: Env, io: IO, deps: UsersDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = parse(rest);
  const base: Rec = { event: 'users_admin', action: cmd ?? null };
  const refuse = (code: string, extra: Rec = {}, exit = 1) => { io.err(JSON.stringify({ ...base, outcome: 'refused', code, ...extra })); return exit; };
  if (!f || !cmd || (cmd !== 'list' && !COMMANDS.has(cmd))) return refuse('users.usage', { message: USAGE }, 2);
  const cfg = loadEngagementConfig(env.RATIO_ENGAGEMENT_CONFIG ?? '');
  const file = env.RATIO_ENGAGEMENT_USERS ?? '';
  if (!cfg.ok) return refuse('users.config_invalid', { problems: cfg.problems }, 2);
  if (!path.isAbsolute(file)) return refuse('users.file_invalid', { problems: ['RATIO_ENGAGEMENT_USERS: must be an absolute path'] }, 2);
  const instance = { tenantId: cfg.config.tenantId, engagementId: cfg.config.engagementId };
  if (cmd === 'list') {
    try {
      const d = parseDoc(fs.readFileSync(file));
      const role = (id: unknown) => d.memberships?.find((m) => same(m.userId, id))?.role ?? null;
      io.out(JSON.stringify({ users: d.users.map((u) => ({ id: u.id, displayName: u.displayName, status: u.status, role: role(u.id),
        localCredential: !!d.localCredentials?.some((c) => same(c.userId, u.id)), bindings: d.bindings?.filter((b) => same(b.userId, u.id)).length ?? 0 })) }));
      return 0;
    } catch { return refuse('users.read_failed'); }
  }
  let unlock: (() => void) | undefined;
  let store: EngagementSessionStore | undefined;
  try {
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch { /* missing: the lock or the read reports it */ }
    if (link) throw new Refused('users.file_symlink'); // never replace a link target silently
    unlock = lock(path.dirname(file));
    sweep(path.dirname(file));
    const original = fs.readFileSync(file);
    const doc = parseDoc(original);
    const by = f.get('by') ?? '';
    const userOf = (id: unknown) => doc.users.find((u) => same(u.id, id));
    const memberOf = (id: unknown) => doc.memberships?.find((m) => same(m.userId, id));
    const activeAdmin = (u: Rec | undefined) => !!u && u.status === 'active' && memberOf(u.id)?.status === 'active' && memberOf(u.id)?.role === 'tenant_admin';
    // The actor label: `operator`, or the id of an active tenant_admin (case-insensitive, never trimmed; recorded canonical).
    const actor = by === 'operator' ? 'operator' : activeAdmin(userOf(by)) ? (userOf(by)!.id as string) : null;
    base.actor = actor ?? null;
    if (!actor) throw new Refused('users.actor_invalid');
    let target = f.get('id');
    const binding = cmd === 'unbind' ? doc.bindings?.find((b) => b.connectionId === f.get('connection') && b.subject === f.get('subject')) : undefined;
    if (cmd === 'unbind') {
      if (!binding) throw new Refused('users.unknown_binding');
      target = binding.userId as string;
    }
    base.target = target ?? null;
    if (!target) throw new Refused('users.usage', { message: USAGE });
    if (same(target, actor)) throw new Refused('users.self_change_refused');
    if (f.has('force') && actor !== 'operator') throw new Refused('users.force_requires_operator');
    const admins = () => doc.users.filter((u) => activeAdmin(u)).length;
    const guardLastAdmin = (before: number) => {
      if (before > 0 && admins() === 0 && !(actor === 'operator' && f.has('force'))) throw new Refused('users.last_admin', { message: 'the last active tenant_admin; only --by operator --force may do this' });
    };
    const password = async () => {
      if (!f.has('password-stdin')) throw new Refused('users.usage', { message: USAGE });
      const pwd = (deps.readStdin ?? (() => fs.readFileSync(0, 'utf8')))().split(/\r\n|\r|\n/)[0];
      try { return await hashPassword(pwd); } catch { throw new Refused('users.password_invalid'); }
    };
    const extra: Rec = {};
    let revoke = false;
    const adminsBefore = admins();
    if (cmd === 'add') {
      if (same(target, 'operator')) throw new Refused('users.id_reserved');
      const role = f.get('role');
      if (!role || !Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Refused('users.role_invalid');
      doc.users.push({ id: target, displayName: f.get('name') ?? '', status: 'active' });
      (doc.memberships ??= []).push({ userId: target, ...instance, role, status: 'active' });
      if (f.has('password-stdin')) (doc.localCredentials ??= []).push({ userId: target, passwordHash: await password() });
      extra.role = role;
    } else if (cmd === 'set-role') {
      const m = memberOf(target);
      if (!m) throw new Refused('users.unknown_user');
      m.role = f.get('role');
      extra.role = m.role;
    } else if (cmd === 'set-password') {
      if (!userOf(target)) throw new Refused('users.unknown_user');
      const hash = await password();
      const c = doc.localCredentials?.find((x) => same(x.userId, target));
      if (c) c.passwordHash = hash; else (doc.localCredentials ??= []).push({ userId: userOf(target)!.id, passwordHash: hash });
    } else if (cmd === 'suspend' || cmd === 'unsuspend') {
      const u = userOf(target);
      if (!u) throw new Refused('users.unknown_user');
      u.status = cmd === 'suspend' ? 'suspended' : 'active';
      revoke = cmd === 'suspend';
    } else if (cmd === 'revoke-sessions') {
      if (!userOf(target)) throw new Refused('users.unknown_user');
      revoke = true;
    } else if (cmd === 'bind') {
      const conn = doc.identityConnections?.find((c) => c.id === f.get('connection'));
      (doc.bindings ??= []).push({ connectionId: f.get('connection'), issuer: conn?.issuer ?? '', subject: f.get('subject'), userId: target, approvedBy: actor, approvedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
      Object.assign(extra, { connection: f.get('connection'), subject: f.get('subject') });
    } else if (cmd === 'unbind') {
      doc.bindings = doc.bindings!.filter((b) => b !== binding);
      Object.assign(extra, { connection: f.get('connection'), subject: f.get('subject') });
      revoke = true;
    } else throw new Refused('users.usage', { message: USAGE });
    guardLastAdmin(adminsBefore);
    const v = validateDirectory(doc, instance);
    if (!v.ok) throw new Refused('users.invalid_result', { problems: v.problems });
    const next = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    if (next.length > (deps.maxBytes ?? MAX_BYTES)) throw new Refused('users.too_large');
    if (revoke) {
      const state = env.RATIO_ENGAGEMENT_STATE ?? '';
      if (!path.isAbsolute(state)) throw new Refused('users.state_missing');
      try { store = new EngagementSessionStore(state); } catch { throw new Refused('users.state_unavailable'); }
    }
    (deps.beforeWrite ?? (() => {}))();
    if (sha(fs.readFileSync(file)) !== sha(original)) throw new Refused('users.changed_concurrently');
    if (cmd !== 'revoke-sessions') {
      let w: true | 'dir';
      try { w = writeAtomic(file, next, deps); } catch (e) { throw new Refused('users.write_failed', { cause: (e as NodeJS.ErrnoException).code ?? 'unknown' }); }
      if (w === 'dir') extra.durability = 'users.dir_sync_failed';
    }
    if (store) {
      try { extra.sessionsRevoked = (deps.revoke ?? ((s, id) => s.revokeUser(id)))(store, userOf(target)!.id as string); } catch {
        if (cmd === 'revoke-sessions') throw new Refused('users.revoke_failed'); // nothing was written: a plain failure
        io.out(JSON.stringify({ ...base, ...extra, outcome: 'partial', code: 'users.revoke_failed' }));
        return 1;
      }
    }
    if (extra.durability) {
      const { durability, ...rest } = extra;
      io.out(JSON.stringify({ ...base, ...rest, outcome: 'partial', code: durability }));
      return 1;
    }
    io.out(JSON.stringify({ ...base, ...extra, outcome: 'success' }));
    return 0;
  } catch (e) {
    if (e instanceof Refused) return refuse(e.message, e.extra);
    return refuse('users.failed');
  } finally {
    try { store?.close(); } catch { /* closing a failed store */ }
    unlock?.();
  }
}
