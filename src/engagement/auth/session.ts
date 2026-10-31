// R2 A2a: server-side sessions for engagement users in node:sqlite at
// RATIO_ENGAGEMENT_STATE (the existing writable /state volume; no new service).
// The same model as the simulation's sessions (src/simulation/server/database.ts):
// a random 256-bit token lives only in the cookie, the store keeps its SHA-256.
// A session names WHO (user id) and WHERE (tenant, engagement), never a role or
// permission: every request re-resolves those from the directory. Absolute
// lifetime 8 h, idle timeout 30 min; revocation and purge on the server. Any
// storage failure is a SessionStoreError with a fixed message (fail closed).
// node:sqlite needs Node >= 22.13 without flags (package.json engines; the
// image is node:24). SERVER-ONLY.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const PURGE_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionBinding { userId: string; tenantId: string; engagementId: string }
export interface SessionRecord extends SessionBinding { createdAt: number; lastSeenAt: number; expiresAt: number }

export class SessionStoreError extends Error {
  constructor() {
    super('session store unavailable');
    this.name = 'SessionStoreError';
  }
}

const TOKEN_RE = /^[a-f0-9]{64}$/;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Runs a storage operation; any failure becomes the fixed SessionStoreError (no path, SQL or driver text). */
function guarded<T>(fn: () => T): T {
  try { return fn(); } catch { throw new SessionStoreError(); }
}

export class EngagementSessionStore {
  private db!: DatabaseSync;
  private lastPurge = 0;
  constructor(filename: string) {
    guarded(() => {
      if (filename !== ':memory:') {
        const dir = dirname(filename);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // An existing directory wider than 0700 is narrowed when it is ours; otherwise refuse (fail closed).
        const st = statSync(dir);
        if (st.mode & 0o077) {
          if (st.uid !== process.getuid?.()) throw new Error('state directory not owned');
          chmodSync(dir, 0o700);
        }
        if (!existsSync(filename)) closeSync(openSync(filename, 'a', 0o600));
      }
      this.db = new DatabaseSync(filename);
      // WAL lets concurrent readers proceed; busy_timeout waits for a concurrent writer instead of failing.
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS engagement_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS engagement_sessions_user ON engagement_sessions (user_id);`);
      if (filename !== ':memory:') for (const f of [filename, `${filename}-wal`, `${filename}-shm`]) if (existsSync(/* turbopackIgnore: true */ f)) chmodSync(/* turbopackIgnore: true */ f, 0o600);
    });
  }
  close(): void { guarded(() => this.db.close()); }

  create(b: SessionBinding, now = Date.now()): { token: string; session: SessionRecord } {
    return guarded(() => {
      this.purge(now);
      const token = randomBytes(32).toString('hex');
      const session: SessionRecord = { ...b, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS };
      this.db.prepare('INSERT INTO engagement_sessions VALUES (?,?,?,?,?,?,?)').run(sha256(token), b.userId, b.tenantId, b.engagementId, now, now, session.expiresAt);
      return { token, session };
    });
  }

  /** The live session of a token (sliding its idle window), or null. Throws SessionStoreError, never returns a guess. */
  get(token: string, now = Date.now()): SessionRecord | null {
    return guarded(() => {
      if (now - this.lastPurge >= PURGE_INTERVAL_MS) this.purge(now);
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const hash = sha256(token);
      const row = this.db.prepare('SELECT * FROM engagement_sessions WHERE hash=? AND expires>? AND last_seen>?').get(hash, now, now - SESSION_IDLE_MS);
      if (!row) return null;
      this.db.prepare('UPDATE engagement_sessions SET last_seen=? WHERE hash=? AND last_seen<?').run(now, hash, now);
      return {
        userId: String(row.user_id), tenantId: String(row.tenant_id), engagementId: String(row.engagement_id),
        createdAt: Number(row.created), lastSeenAt: Math.max(now, Number(row.last_seen)), expiresAt: Number(row.expires),
      };
    });
  }

  revoke(token: string): void {
    guarded(() => { if (typeof token === 'string' && TOKEN_RE.test(token)) this.db.prepare('DELETE FROM engagement_sessions WHERE hash=?').run(sha256(token)); });
  }

  /** Ends every session of one user (suspension, operator rotation); returns how many ended. */
  revokeUser(userId: string): number {
    return guarded(() => Number(this.db.prepare('DELETE FROM engagement_sessions WHERE user_id=?').run(userId).changes));
  }

  /** Deletes absolutely expired and idle sessions; returns how many. */
  purge(now = Date.now()): number {
    return guarded(() => {
      this.lastPurge = now;
      return Number(this.db.prepare('DELETE FROM engagement_sessions WHERE expires<=? OR last_seen<=?').run(now, now - SESSION_IDLE_MS).changes);
    });
  }

  count(): number { return guarded(() => Number(this.db.prepare('SELECT count(*) AS n FROM engagement_sessions').get()?.n)); }
}

const stores = new Map<string, EngagementSessionStore>();
/** One store per state file per process. */
export function sessionStore(file: string): EngagementSessionStore {
  let s = stores.get(file);
  if (!s) stores.set(file, (s = new EngagementSessionStore(file)));
  return s;
}
