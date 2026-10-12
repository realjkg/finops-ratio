// PR #115 follow-ups: a locked re-ingest keeps Disconnect while its run is shown, and the
// landed-data line only links Findings when the run has findings.
import { expect, it } from 'vitest';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { FocusFileAdapter } from '@/costsource';
import { rawRowsForVersion, sourcesForEnv } from '@/costsource/seed';
import type { CostFinding } from '@/costsource/CostSourceClient';
import { ConnectorCard } from './ConnectorCard';
import { IngestVerification } from './IngestVerification';
import { currentMonthWindow, type IngestRun } from './ingestLanding';

const noOp = () => {};
const source = sourcesForEnv({}).find((s) => s.id === 'pointfive-sandbox')!;
const locked = { state: 'locked' as const, error: 'auth', openedAt: '2026-06-01T14:29:00.000Z' };
const run = (o: { rows?: boolean; wl?: string; findings?: number } = {}): IngestRun => {
  const r = FocusFileAdapter.ingest(rawRowsForVersion('1.0'), '1.0', source.id, currentMonthWindow());
  const rows = o.rows === false ? [] : r.rows.map((x) => ({ ...x, x_RatioWorkloadId: o.wl ?? '' }));
  const findings = Array.from({ length: o.findings ?? 0 }, (_, i) => ({ id: `f${i}` }) as CostFinding);
  return { sourceId: source.id, sourceName: 'T', at: '2026-06-01T14:30:00.000Z', result: { ...r, rows }, findings };
};
const card = (r?: IngestRun) =>
  html(<ConnectorCard source={source} session={locked} run={r} onConnect={noOp} onIngest={noOp} onDisconnect={noOp} />);
const verdict = (r: IngestRun) => html(<IngestVerification run={r} sandbox={false} />);

it('locked card keeps Disconnect (no Retry/Ingest) with a landed run, no button without one', () => {
  const h = card(run());
  expect(h).toContain('Disconnect');
  expect(h).not.toMatch(/Retry|Ingest now|Re-ingest|>Connect</);
  expect(card()).not.toContain('<button');
});

it('links Findings only when the run has findings; Attribution stays', () => {
  for (const wl of ['', 'wl-1']) {
    expect(verdict(run({ wl }))).not.toContain('>Findings</a>');
    expect(verdict(run({ wl, findings: 1 }))).toContain('>Findings</a>');
  }
  expect(verdict(run())).toContain('>Attribution</a>');
});

it('an empty window says no rows were returned, never "Rows normalized"', () => {
  const h = verdict(run({ rows: false }));
  expect(h).toContain('No rows returned');
  expect(h).not.toContain('Rows normalized');
});
