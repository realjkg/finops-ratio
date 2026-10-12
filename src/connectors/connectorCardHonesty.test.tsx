import { expect, it } from 'vitest';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { FocusFileAdapter } from '@/costsource';
import { rawRowsForVersion, sourcesForEnv } from '@/costsource/seed';
import { ConnectorCard } from './ConnectorCard';
import { IngestVerification } from './IngestVerification';
import { currentMonthWindow, type IngestRun } from './ingestLanding';

const source = sourcesForEnv({}).find((s) => s.id === 'pointfive-sandbox')!;
const run = (o: { rows?: boolean; wl?: string; n?: number } = {}): IngestRun => {
  const r = FocusFileAdapter.ingest(rawRowsForVersion('1.0'), '1.0', source.id, currentMonthWindow());
  const rows = o.rows === false ? [] : r.rows.map((x) => ({ ...x, x_RatioWorkloadId: o.wl ?? '' }));
  return { sourceId: source.id, sourceName: 'T', at: '2026-06-01T14:30:00.000Z', result: { ...r, rows },
    findings: Array.from({ length: o.n ?? 0 }, (_, i) => ({ id: `f${i}` }) as IngestRun['findings'][number]) };
};
const session = { state: 'locked' as const, error: 'auth', openedAt: '2026-06-01T14:29:00.000Z' };
const card = (r?: IngestRun) =>
  html(<ConnectorCard source={source} session={session} run={r} onConnect={() => {}} onIngest={() => {}} onDisconnect={() => {}} />);
const verdict = (r: IngestRun) => html(<IngestVerification run={r} sandbox={false} />);

it('locked card keeps Disconnect (no Retry/Ingest) with a landed run, no button without one', () => {
  expect(card(run())).toMatch(/^(?!.*(Retry|Ingest now|Re-ingest|>Connect<)).*Disconnect/);
  expect(card()).not.toContain('<button');
});
it('links Findings only when the run has findings; Attribution stays', () => {
  for (const wl of ['', 'wl-1']) {
    expect(verdict(run({ wl }))).not.toContain('>Findings</a>');
    expect(verdict(run({ wl, n: 1 }))).toContain('>Findings</a>');
  }
  expect(verdict(run())).toContain('>Attribution</a>');
});
it('an empty window says no rows were returned, never "Rows normalized"', () => {
  expect(verdict(run({ rows: false }))).toMatch(/^(?!.*Rows normalized).*No rows returned/);
});
