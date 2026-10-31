// R2: the engagement report page (browser). It reads the report only from the
// slice-C route with the same-origin session cookie (HttpOnly: the page never
// sees a token); export links appear only with reports:export. Server
// messages are never shown: fixed text per status. No server-only imports.
import { useCallback, useEffect, useState } from 'react';
import { EngagementReportView } from '@/reports/EngagementReportView';
import type { EngagementReportModel } from '@/reports/engagementReportModel';
import type { ReportPageProps } from './reportPage';

const MESSAGES: Record<number, string> = {
  401: 'Your session has ended. Reload the page to sign in again.',
  403: 'Your account does not have access to this report.',
  429: 'Too many requests. Wait a minute and try again.',
};
const url = (period: string, format: string) => `/api/v1/reports/engagement?period=${encodeURIComponent(period)}&format=${format}`;
const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="min-h-screen bg-deep p-4 text-txt sm:p-8"><div className="mx-auto max-w-6xl space-y-6"><h1 className="text-2xl font-semibold">Engagement report</h1>{children}</div></main>
);

function Ready({ displayName, canExport, defaultPeriod }: { displayName: string; canExport: boolean; defaultPeriod: string }) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [shown, setShown] = useState(defaultPeriod);
  const [model, setModel] = useState<EngagementReportModel | null>(null);
  const [status, setStatus] = useState('Loading the report…');
  const load = useCallback(async (p: string) => {
    setStatus('Loading the report…');
    setModel(null);
    try {
      const res = await fetch(url(p, 'json'), { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return setStatus(MESSAGES[res.status] ?? 'The report is unavailable right now. Try again later.');
      setModel((await res.json()) as EngagementReportModel);
      setShown(p);
      setStatus(`Report for ${p}`);
    } catch {
      setStatus('The report is unavailable right now. Try again later.');
    }
  }, []);
  useEffect(() => { void load(defaultPeriod); }, [load, defaultPeriod]);
  return (
    <Shell>
      <p className="text-sm text-sub">Signed in as {displayName}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void load(period); }}>
        <label className="flex flex-col gap-1 text-sm">Billing month<input type="month" className="rounded border border-edge bg-deep px-2 py-1 text-txt" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button type="submit" className="sim-button">Load report</button>
      </form>
      <p role="status" className="text-sm text-sub">{status}</p>
      {model && canExport && (
        <nav aria-label="Exports" className="flex gap-5 text-sm"><a className="text-unit underline" href={url(shown, 'xlsx')}>Download XLSX</a><a className="text-unit underline" href={url(shown, 'pdf')}>Download PDF</a></nav>
      )}
      {model && <EngagementReportView model={model} />}
    </Shell>
  );
}

export function EngagementReportPage(props: ReportPageProps) {
  if (props.state === 'ready') return <Ready {...props} />;
  if (props.state === 'signin') {
    return (
      <Shell>
        <p className="text-sm text-sub">Sign in to view this engagement&apos;s report.</p>
        {props.connections.length ? (
          <ul className="space-y-2">{props.connections.map((c) => <li key={c}><a className="text-unit underline" href={`/api/auth/oidc/start?connection=${encodeURIComponent(c)}`}>Sign in with {c}</a></li>)}</ul>
        ) : <p className="text-sm text-sub">No sign-in connection is configured. Ask your operator.</p>}
      </Shell>
    );
  }
  return <Shell><p className="text-sm text-sub">{props.state === 'denied' ? 'Your account does not have access to this report.' : 'The report is temporarily unavailable. Try again later.'}</p></Shell>;
}
