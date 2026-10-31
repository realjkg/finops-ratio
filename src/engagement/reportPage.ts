// R2: the server side of the /engagement report page (getServerSideProps). The
// page exists only in engagement mode (null ⇒ 404). Its state comes from the
// same session check as the report routes (checkReportAccess, reports:read,
// audited as format 'page'); the page reads no data itself. Anonymous visitors
// get 401 and one sign-in link per ENABLED identity connection. SERVER-ONLY.
import { engagementConfigFromEnv, engagementMode } from './config';
import { directoryFromEnv } from './auth/directory';
import type { RequestLike } from './auth/http';
import { checkReportAccess, type ReportAccessDeps } from './auth/reportAccess';

type Env = Record<string, string | undefined>;
export type ReportPageProps =
  | { state: 'signin'; connections: string[] }
  | { state: 'denied' }
  | { state: 'unavailable' }
  | { state: 'ready'; displayName: string; canExport: boolean; defaultPeriod: string };

function enabledConnections(env: Env): string[] {
  const cfg = engagementConfigFromEnv(env);
  const dir = cfg.ok ? directoryFromEnv(env, cfg.config) : null;
  return dir?.ok ? [...dir.directory.connections.values()].filter((c) => c.enabled).map((c) => c.id) : [];
}

export function reportPageProps(req: RequestLike, env: Env, deps: ReportAccessDeps = {}): { status: number; props: ReportPageProps } | null {
  try {
    if (!engagementMode(env)) return null;
  } catch {
    return null;
  }
  const a = checkReportAccess(req, env, 'reports:read', 'page', deps);
  if (!a.ok) {
    if (a.status === 401) return { status: 401, props: { state: 'signin', connections: enabledConnections(env) } };
    return a.status === 403 ? { status: 403, props: { state: 'denied' } } : { status: 503, props: { state: 'unavailable' } };
  }
  const d = new Date((deps.now ?? Date.now)());
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const defaultPeriod = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  return { status: 200, props: { state: 'ready', displayName: a.displayName, canExport: a.can('reports:export'), defaultPeriod } };
}
