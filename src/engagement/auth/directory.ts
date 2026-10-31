// R2: the identity directory of one engagement instance, a read-only JSON file
// named by RATIO_ENGAGEMENT_USERS (mounted at /config/users.json by the R12
// compose file). Separate from the engagement config and from data connectors.
//   users               internal Ratio users { id, displayName, status }
//   localCredentials    bootstrap/recovery sign-in { userId, passwordHash (scrypt) }
//   identityConnections tenant-bound IdP connections { id, tenantId, protocol: oidc, issuer, clientId,
//                       clientSecretRef (an env var NAME, never a secret), provisioning: invite-only, enabled }
//   bindings            EXPLICIT external identity -> user { connectionId, issuer, subject, userId, approvedBy, approvedAt }
//   memberships         { userId, tenantId, engagementId, role, status }, one per user
//   teams               tenant-scoped groups { id, tenantId, displayName, members, permissions? }
// Nothing is linked by email or display name. Every record must belong to this
// instance's tenant and engagement, so an edit cannot move a connection or a
// membership to another tenant silently: startup refuses it. Validated at
// startup and re-read on every use (an in-place edit is effective on the next
// request). Problems name the KEY, never the value. SERVER-ONLY.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EngagementConfigError } from '../config';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from './authz';
import { isPasswordHash } from './password';

type Env = Record<string, string | undefined>;
type Status = 'active' | 'suspended';
export interface Instance { tenantId: string; engagementId: string }
export interface User { id: string; displayName: string; status: Status }
export interface Connection { id: string; tenantId: string; protocol: 'oidc'; issuer: string; clientId: string; clientSecretRef: string; provisioning: 'invite-only'; enabled: boolean }
export interface Membership { userId: string; tenantId: string; engagementId: string; role: Role; status: Status }
export interface Team { id: string; tenantId: string; displayName: string; members: string[]; permissions: Permission[] }
export interface Directory {
  /** Keyed by the lower-cased id. Every other map uses the user's canonical id. */
  users: ReadonlyMap<string, User>;
  credentials: ReadonlyMap<string, string>;
  connections: ReadonlyMap<string, Connection>;
  memberships: ReadonlyMap<string, Membership>;
  teams: readonly Team[];
  bindingOf(connectionId: string, issuer: string, subject: string): string | undefined;
  teamsOf(userId: string): Team[];
}
export type DirectoryResult = { ok: true; directory: Directory } | { ok: false; problems: string[] };

const V = 'RATIO_ENGAGEMENT_USERS';
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TOP = ['version', 'users', 'localCredentials', 'identityConnections', 'bindings', 'memberships', 'teams'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && ![...v].some((c) => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));
function isHttpsUrl(v: unknown): v is string {
  if (!text(v, 512)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
}
const bindingKey = (c: string, i: string, s: string) => JSON.stringify([c, i, s]);

export function validateDirectory(input: unknown, instance: Instance): DirectoryResult {
  if (!isObject(input)) return { ok: false, problems: ['directory: must be a JSON object'] };
  const problems: string[] = [];
  const bad = (key: string, why: string) => { problems.push(`${key}: ${why}`); };
  if (Object.keys(input).some((k) => !TOP.includes(k))) bad('directory', 'unknown field');
  if (input.version !== 1) bad('version', 'must be 1');
  const list = (key: string, required: boolean): Record<string, unknown>[] => {
    const v = input[key];
    if (v === undefined && !required) return [];
    if (!Array.isArray(v) || v.length > MAX_ENTRIES || (required && v.length === 0)) { bad(key, `must be a ${required ? 'non-empty ' : ''}array of at most ${MAX_ENTRIES} entries`); return []; }
    return v.map((e, i) => (isObject(e) ? e : (bad(`${key}[${i}]`, 'must be an object'), {})));
  };
  const fields = (at: string, o: Record<string, unknown>, keys: string[]) => { if (Object.keys(o).some((k) => !keys.includes(k))) bad(at, 'unknown field'); };
  const own = (at: string, key: 'tenantId' | 'engagementId', v: unknown) => {
    if (typeof v !== 'string' || v.toLowerCase() !== instance[key].toLowerCase()) bad(`${at}.${key}`, `must equal the ${key} of this instance`);
  };
  const users = new Map<string, User>();
  const userRef = (at: string, v: unknown): string | null => {
    const u = typeof v === 'string' ? users.get(v.toLowerCase()) : undefined;
    if (!u) bad(at, 'unknown user');
    return u?.id ?? null;
  };
  list('users', true).forEach((u, i) => {
    const at = `users[${i}]`;
    fields(at, u, ['id', 'displayName', 'status']);
    if (typeof u.id !== 'string' || !ID_RE.test(u.id)) return bad(`${at}.id`, 'must be 1 to 63 letters, digits, dots, underscores or hyphens');
    if (users.has(u.id.toLowerCase())) return bad(`${at}.id`, 'duplicate (ids are case-insensitive)');
    if (!text(u.displayName, 80)) bad(`${at}.displayName`, 'must be 1 to 80 printable characters');
    if (u.status !== 'active' && u.status !== 'suspended') bad(`${at}.status`, 'must be active or suspended');
    users.set(u.id.toLowerCase(), { id: u.id, displayName: String(u.displayName), status: u.status as Status });
  });
  const credentials = new Map<string, string>();
  list('localCredentials', false).forEach((c, i) => {
    const at = `localCredentials[${i}]`;
    fields(at, c, ['userId', 'passwordHash']);
    const id = userRef(`${at}.userId`, c.userId);
    if (!isPasswordHash(c.passwordHash)) bad(`${at}.passwordHash`, 'must be a scrypt hash (scrypt$logN$r$p$salt$key)');
    else if (id && credentials.has(id)) bad(`${at}.userId`, 'duplicate credential');
    else if (id) credentials.set(id, c.passwordHash);
  });
  const connections = new Map<string, Connection>();
  list('identityConnections', false).forEach((c, i) => {
    const at = `identityConnections[${i}]`;
    fields(at, c, ['id', 'tenantId', 'protocol', 'issuer', 'clientId', 'clientSecretRef', 'provisioning', 'enabled']);
    const before = problems.length;
    if (typeof c.id !== 'string' || !ID_RE.test(c.id) || connections.has(c.id)) bad(`${at}.id`, 'must be a unique id of 1 to 63 letters, digits, dots, underscores or hyphens');
    own(at, 'tenantId', c.tenantId);
    if (c.protocol !== 'oidc') bad(`${at}.protocol`, 'must be oidc');
    if (!isHttpsUrl(c.issuer)) bad(`${at}.issuer`, 'must be an https URL without query, fragment or user info');
    if (!text(c.clientId, 256)) bad(`${at}.clientId`, 'must be 1 to 256 printable characters');
    if (typeof c.clientSecretRef !== 'string' || !ENV_NAME_RE.test(c.clientSecretRef)) bad(`${at}.clientSecretRef`, 'must be the NAME of an environment variable (A-Z, 0-9, _)');
    if (c.provisioning !== 'invite-only') bad(`${at}.provisioning`, 'must be invite-only');
    if (typeof c.enabled !== 'boolean') bad(`${at}.enabled`, 'must be true or false');
    if (problems.length === before) connections.set(c.id as string, { ...(c as unknown as Connection), tenantId: instance.tenantId });
  });
  const bindings = new Map<string, string>();
  list('bindings', false).forEach((b, i) => {
    const at = `bindings[${i}]`;
    fields(at, b, ['connectionId', 'issuer', 'subject', 'userId', 'approvedBy', 'approvedAt']);
    const conn = typeof b.connectionId === 'string' ? connections.get(b.connectionId) : undefined;
    if (!conn) bad(`${at}.connectionId`, 'unknown connection');
    else if (b.issuer !== conn.issuer) bad(`${at}.issuer`, "must equal the connection's issuer");
    if (!text(b.subject, 255)) bad(`${at}.subject`, 'must be 1 to 255 printable characters');
    const id = userRef(`${at}.userId`, b.userId);
    if (b.approvedBy !== 'operator') userRef(`${at}.approvedBy`, b.approvedBy);
    if (typeof b.approvedAt !== 'string' || !ISO_RE.test(b.approvedAt) || Number.isNaN(Date.parse(b.approvedAt))) bad(`${at}.approvedAt`, 'must be an ISO 8601 UTC time');
    if (!conn || !id || !text(b.subject, 255)) return;
    const key = bindingKey(conn.id, conn.issuer, b.subject);
    if (bindings.has(key)) bad(at, 'duplicate external identity');
    else bindings.set(key, id);
  });
  const memberships = new Map<string, Membership>();
  list('memberships', false).forEach((m, i) => {
    const at = `memberships[${i}]`;
    fields(at, m, ['userId', 'tenantId', 'engagementId', 'role', 'status']);
    const id = userRef(`${at}.userId`, m.userId);
    own(at, 'tenantId', m.tenantId);
    own(at, 'engagementId', m.engagementId);
    if (typeof m.role !== 'string' || !Object.hasOwn(ROLE_PERMISSIONS, m.role)) bad(`${at}.role`, `must be one of ${Object.keys(ROLE_PERMISSIONS).join(', ')}`);
    if (m.status !== 'active' && m.status !== 'suspended') bad(`${at}.status`, 'must be active or suspended');
    if (id && memberships.has(id)) bad(`${at}.userId`, 'duplicate membership');
    else if (id) memberships.set(id, { userId: id, tenantId: instance.tenantId, engagementId: instance.engagementId, role: m.role as Role, status: m.status as Status });
  });
  const teams: Team[] = [];
  list('teams', false).forEach((t, i) => {
    const at = `teams[${i}]`;
    fields(at, t, ['id', 'tenantId', 'displayName', 'members', 'permissions']);
    if (typeof t.id !== 'string' || !ID_RE.test(t.id) || teams.some((x) => x.id === t.id)) bad(`${at}.id`, 'must be a unique id of 1 to 63 letters, digits, dots, underscores or hyphens');
    own(at, 'tenantId', t.tenantId);
    if (!text(t.displayName, 80)) bad(`${at}.displayName`, 'must be 1 to 80 printable characters');
    const members = Array.isArray(t.members) ? t.members.map((m, j) => userRef(`${at}.members[${j}]`, m)) : (bad(`${at}.members`, 'must be an array of user ids'), []);
    const perms = t.permissions === undefined ? [] : Array.isArray(t.permissions) ? t.permissions : (bad(`${at}.permissions`, 'must be an array'), []);
    perms.forEach((p, j) => { if (!(PERMISSIONS as readonly unknown[]).includes(p)) bad(`${at}.permissions[${j}]`, 'unknown permission'); });
    teams.push({ id: String(t.id), tenantId: instance.tenantId, displayName: String(t.displayName), members: [...new Set(members.filter((m): m is string => !!m))], permissions: perms as Permission[] });
  });
  if (problems.length) return { ok: false, problems };
  return { ok: true, directory: {
    users, credentials, connections, memberships, teams,
    bindingOf: (c, i, s) => bindings.get(bindingKey(c, i, s)),
    teamsOf: (userId) => teams.filter((t) => t.members.includes(userId)),
  } };
}

export function loadDirectory(file: string, instance: Instance): { ok: true; directory: Directory; sha256: string } | { ok: false; problems: string[] } {
  if (typeof file !== 'string' || file.trim() === '') return { ok: false, problems: [`${V}: is missing`] };
  if (!path.isAbsolute(file)) return { ok: false, problems: [`${V}: must be an absolute path`] };
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch { return { ok: false, problems: [`${V}: file is missing or unreadable`] }; }
  if (bytes.length > MAX_BYTES) return { ok: false, problems: [`${V}: file is larger than 512 KiB`] };
  let doc: unknown;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, problems: [`${V}: file is not valid JSON`] }; }
  const r = validateDirectory(doc, instance);
  return r.ok ? { ...r, sha256: createHash('sha256').update(bytes).digest('hex') } : r;
}

/** Re-read on every call: role, membership, binding and suspension changes apply to the next request. */
export const directoryFromEnv = (env: Env, instance: Instance) => loadDirectory(env[V] ?? '', instance);

/** Startup check (instrumentation, engagement mode only): throws EngagementConfigError naming keys only. */
export function checkDirectoryStartup(env: Env, instance: Instance): Directory {
  const r = directoryFromEnv(env, instance);
  if (!r.ok) throw new EngagementConfigError(r.problems);
  return r.directory;
}
