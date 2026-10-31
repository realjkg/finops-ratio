// R2 A2a: the server-side session store (node:sqlite on /state). Only the
// SHA-256 of a session token is stored; absolute and idle expiry, revocation
// and purge are decided on the server; failures are fixed-message errors.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EngagementSessionStore, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SessionStoreError } from './session';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-session-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const T0 = Date.UTC(2026, 10, 1, 12);
const P = { userId: 'a.viewer', tenantId: '11111111-1111-4111-8111-111111111111', engagementId: 'eng-a' };
const mem = () => new EngagementSessionStore(':memory:');

describe('EngagementSessionStore', () => {
  it('stores only the token hash, WAL mode, owner-only file and directory; tokens are 256-bit hex', () => {
    const file = path.join(dir, 'state', 'sessions.sqlite');
    const store = new EngagementSessionStore(file);
    const { token, session } = store.create(P, T0);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(session).toEqual({ ...P, createdAt: T0, lastSeenAt: T0, expiresAt: T0 + SESSION_ABSOLUTE_MS });
    store.close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const db = new DatabaseSync(file);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    const rows = db.prepare('SELECT * FROM engagement_sessions').all();
    db.close();
    expect(rows).toHaveLength(1);
    const bytes = ['', '-wal'].map((s) => (fs.existsSync(file + s) ? fs.readFileSync(file + s).toString('latin1') : '')).join('');
    expect(JSON.stringify(rows) + bytes).not.toContain(token);
  });

  it('the -wal and -shm files are 0600 too; an existing state directory wider than 0700 is narrowed to 0700', () => {
    const wide = path.join(dir, 'wide');
    fs.mkdirSync(wide, { mode: 0o755 });
    fs.chmodSync(wide, 0o755);
    const file = path.join(wide, 's.sqlite');
    const s = new EngagementSessionStore(file);
    s.create(P, T0);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(fs.statSync(f).mode & 0o777, f).toBe(0o600);
    expect(fs.statSync(wide).mode & 0o777).toBe(0o700);
    s.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o644); // files left by an older build
    const again = new EngagementSessionStore(file);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) expect(fs.statSync(f).mode & 0o777, `reopened ${f}`).toBe(0o600);
    again.close();
  });

  it('absolute lifetime 8 h and idle timeout 30 min; activity slides only the idle window', () => {
    expect([SESSION_ABSOLUTE_MS, SESSION_IDLE_MS]).toEqual([8 * 3600_000, 30 * 60_000]);
    const s = mem();
    const { token } = s.create(P, T0);
    expect(s.get(token, T0 + SESSION_IDLE_MS - 1)).toMatchObject({ lastSeenAt: T0 + SESSION_IDLE_MS - 1 });
    expect(s.get(token, T0 + 2 * SESSION_IDLE_MS - 2)).not.toBeNull(); // slid
    expect(s.get(token, T0 + 3 * SESSION_IDLE_MS - 2)).toBeNull(); // idle expired
    const { token: busy } = s.create(P, T0);
    for (let t = T0; t < T0 + SESSION_ABSOLUTE_MS; t += SESSION_IDLE_MS / 2) expect(s.get(busy, t), String(t)).not.toBeNull();
    expect(s.get(busy, T0 + SESSION_ABSOLUTE_MS - 1)).not.toBeNull(); // also runs the purge
    expect(s.get(busy, T0 + SESSION_ABSOLUTE_MS)).toBeNull(); // absolute, despite activity, 1 ms after the last purge
  });

  it('expiry is decided by the read itself, not only by the periodic purge (no purge between these reads)', () => {
    const s = mem();
    const idle = s.create(P, T0).token;
    const other = s.create(P, T0).token;
    expect(s.get(other, T0 + SESSION_IDLE_MS - 1)).not.toBeNull(); // runs the purge; nothing has expired yet
    expect(s.get(idle, T0 + SESSION_IDLE_MS)).toBeNull(); // idle for exactly 30 min, 1 ms after the last purge
  });

  it('revoke, revokeUser and purge act on the server; malformed or tampered tokens never match', () => {
    const s = mem();
    const a = s.create(P, T0).token;
    const b = s.create(P, T0).token;
    const c = s.create({ ...P, userId: 'other' }, T0).token;
    for (const t of ['', 'x', a.toUpperCase(), `${a}0`, `${a.slice(0, 63)}${a[63] === '0' ? '1' : '0'}`, undefined as unknown as string]) expect(s.get(t, T0)).toBeNull();
    s.revoke(a);
    expect(s.get(a, T0)).toBeNull();
    expect(s.revokeUser('a.viewer')).toBe(1);
    expect(s.get(b, T0)).toBeNull();
    expect(s.get(c, T0)).not.toBeNull();
    s.create(P, T0);
    expect(s.purge(T0 + SESSION_IDLE_MS)).toBe(2); // c and the new one: idle
    expect(s.purge(T0 + SESSION_IDLE_MS)).toBe(0);
  });

  it('expired rows are purged during normal use (no unbounded growth)', () => {
    const s = mem();
    for (let i = 0; i < 5; i += 1) s.create(P, T0);
    s.create(P, T0 + SESSION_ABSOLUTE_MS); // a later create purges the expired rows
    expect(s.count()).toBe(1);
  });

  it('two stores on one file (two app processes) see each other\'s sessions and revocations', () => {
    const file = path.join(dir, 'shared.sqlite');
    const one = new EngagementSessionStore(file);
    const two = new EngagementSessionStore(file);
    const tokens = Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).create(P, T0).token);
    for (const t of tokens) expect(one.get(t, T0 + 1)).not.toBeNull();
    two.revoke(tokens[0]);
    expect(one.get(tokens[0], T0 + 2)).toBeNull();
    one.close();
    two.close();
  });

  it('fails closed with a fixed message (no path, no SQL) when the store is unavailable', () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const bad = path.join(blocker, 'sessions.sqlite');
    expect(() => new EngagementSessionStore(bad)).toThrow(SessionStoreError);
    try { new EngagementSessionStore(bad); } catch (e) { expect((e as Error).message).toBe('session store unavailable'); }
    const s = mem();
    s.close();
    expect(() => s.create(P, T0)).toThrow(new SessionStoreError());
    expect(() => s.get('a'.repeat(64), T0)).toThrow(new SessionStoreError());
  });
});
