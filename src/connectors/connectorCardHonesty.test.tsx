// Honesty follow-ups to PR #115: a locked re-ingest must not strand landed data without a
// Disconnect, and the "none matched a workload" line must only point at surfaces that render.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FocusFileAdapter } from '@/costsource';
import { rawRowsForVersion, sourcesForEnv } from '@/costsource/seed';
import type { CostFinding } from '@/costsource/CostSourceClient';
import { ConnectorCard } from './ConnectorCard';
import { IngestVerification } from './IngestVerification';
import { currentMonthWindow, type ConnectorSession, type IngestRun } from './ingestLanding';

const noOp = () => {};
const source = sourcesForEnv({}).find((s) => s.id === 'pointfive-sandbox')!;
const locked: ConnectorSession = { state: 'locked', error: 'auth', openedAt: '2026-06-01T14:29:00.000Z' };

function run(opts: { rows?: boolean; workloads?: boolean; findings?: number } = {}): IngestRun {
  const { rows = true, workloads = false, findings = 0 } = opts;
  const result = FocusFileAdapter.ingest(rawRowsForVersion('1.0'), '1.0', source.id, currentMonthWindow());
  return {
    sourceId: source.id,
    sourceName: 'Test',
    at: '2026-06-01T14:30:00.000Z',
    result: {
      ...result,
      rows: rows
        ? result.rows.map((r) => ({ ...r, x_RatioWorkloadId: workloads ? 'wl-1' : '' }))
        : [],
    },
    findings: Array.from({ length: findings }, (_, i) => ({ id: `f${i}` }) as CostFinding),
  };
}

const card = (r?: IngestRun) =>
  renderToStaticMarkup(
    <ConnectorCard source={source} session={locked} run={r} onConnect={noOp} onIngest={noOp} onDisconnect={noOp} />,
  );
const verdict = (r: IngestRun) => renderToStaticMarkup(<IngestVerification run={r} sandbox={false} />);

describe('ConnectorCard — locked session', () => {
  it('offers Disconnect (not Retry or Ingest) while a landed run is still shown', () => {
    const html = card(run());
    expect(html).toContain('Data landed');
    expect(html).toContain('Disconnect');
    expect(html).not.toMatch(/Retry|Ingest now|Re-ingest|>Connect</);
  });

  it('with no landed run offers no action at all', () => {
    expect(card()).not.toMatch(/<button/);
  });
});

describe('IngestVerification — provenance links', () => {
  it('omits the Findings link when the run has no findings', () => {
    const html = verdict(run());
    expect(html).toContain('none matched a workload');
    expect(html).not.toContain('>Findings</a>');
    expect(html).toContain('>Attribution</a>');
  });

  it('keeps the Findings link when the run has findings', () => {
    expect(verdict(run({ findings: 2 }))).toContain('>Findings</a>');
    expect(verdict(run({ workloads: true, findings: 1 }))).toContain('>Findings</a>');
  });

  it('does not link Findings next to Workloads when there are none', () => {
    const html = verdict(run({ workloads: true }));
    expect(html).toContain('>Workloads</a>');
    expect(html).not.toContain('>Findings</a>');
  });

  it('says no rows were returned for an empty window, never "Rows normalized"', () => {
    const html = verdict(run({ rows: false }));
    expect(html).toContain('No rows returned');
    expect(html).not.toContain('Rows normalized');
  });
});
