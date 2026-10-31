// R2 slice C: named-user access to the engagement report routes. One check,
// deny by default: the session principal (re-resolved from the directory on
// every request) must pass authorize() for the report resource of THIS
// instance (tenant and engagement from the server's engagement config, never
// the request; version = the config sha256) with reports:read (facts, json)
// or reports:export (xlsx, pdf). Uniform results: 401 'Sign-in required' when
// there is no valid session or user, 403 'Not permitted' for any other
// denial, 503 when sign-in is not configured or the store fails. One audit
// event per request: ids, format, permission and outcome only. SERVER-ONLY.
import { engagementConfigFromEnv } from '@/engagement/config';
import { authorize, runAuditHook, type Permission } from './authz';
import { directoryFromEnv } from './directory';
import { authSettings, resolveSessionPrincipal, type RequestLike } from './http';
import { sessionStore, SessionStoreError, type EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
export interface ReportAuditEvent {
  event: 'report_access'; principalKind: 'user' | 'none'; principalId: string | null; tenantId: string; engagementId: string;
  format: string; permission: Permission; outcome: 'allow' | 'deny'; status: number;
}
export interface ReportAccessDeps { store?: (file: string) => EngagementSessionStore; now?: () => number; audit?: (e: ReportAuditEvent) => void | Promise<void> }
export type ReportAccess = { ok: true; userId: string; displayName: string; can(p: Permission): boolean } | { ok: false; status: 401 | 403 | 503; code: string; message: string };

const NOT_CONFIGURED: ReportAccess = { ok: false, status: 503, code: 'not_configured', message: 'Sign-in is not configured on this server' };

export function checkReportAccess(req: RequestLike, env: Env, permission: Permission, format: string, deps: ReportAccessDeps = {}): ReportAccess {
  const settings = authSettings(env);
  const cfg = engagementConfigFromEnv(env);
  if (!settings || !cfg.ok) return NOT_CONFIGURED;
  const instance = { tenantId: cfg.config.tenantId, engagementId: cfg.config.engagementId };
  const dir = directoryFromEnv(env, instance);
  if (!dir.ok) return NOT_CONFIGURED;
  let principal;
  try {
    principal = resolveSessionPrincipal(req, { store: (deps.store ?? sessionStore)(settings.stateFile), directory: dir.directory, instance, now: (deps.now ?? Date.now)() });
  } catch (e) {
    if (e instanceof SessionStoreError) return { ok: false, status: 503, code: 'session_store_unavailable', message: 'Sign-in is temporarily unavailable' };
    throw e;
  }
  const resource = { type: 'report', id: 'engagement-report', ...instance, version: cfg.sha256 } as const;
  const d = authorize(dir.directory, principal, permission, resource);
  const status = d.allow ? 200 : d.status;
  const sink = deps.audit ?? ((e: ReportAuditEvent) => console.info(JSON.stringify(e)));
  runAuditHook(sink, { event: 'report_access', principalKind: principal ? 'user' : 'none', principalId: principal?.id ?? null, ...instance, format, permission, outcome: d.allow ? 'allow' : 'deny', status });
  if (d.allow) {
    const can = (p: Permission) => authorize(dir.directory, principal, p, resource).allow;
    return { ok: true, userId: d.principal.id, displayName: dir.directory.users.get(d.principal.id.toLowerCase())?.displayName ?? d.principal.id, can };
  }
  return d.status === 401 ? { ok: false, status: 401, code: 'unauthorized', message: 'Sign-in required' } : { ok: false, status: 403, code: 'forbidden', message: 'Not permitted' };
}
