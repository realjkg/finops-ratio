// ConnectorCard — H3: the browser "Test connection" only probes offline sandbox
// sources. Live connectors are probed through the authenticated API
// (GET /api/v1/connectors?probe=true); no token ever reaches the browser.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectorCard } from './ConnectorCard';
import { sourcesForEnv } from '@/costsource/seed';
import type { CostSourceDescriptor } from '@/costsource/CostSourceClient';

const onTest = async () => {
  throw new Error('not called during render');
};

function sourceById(id: string): CostSourceDescriptor {
  const src = sourcesForEnv({ KUBERNETES_FOCUS_ENDPOINT: 'https://billing.internal/focus.csv' }).find((s) => s.id === id);
  if (!src) throw new Error(`missing ${id}`);
  return src;
}

function testButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:Testing…|Test connection)<\/button>/);
  if (!m) throw new Error('Test connection button not rendered');
  return m[0];
}

describe('ConnectorCard — Test connection gating (H3)', () => {
  it('enables Test connection for an offline sandbox source', () => {
    const html = renderToStaticMarkup(<ConnectorCard source={sourceById('pointfive-sandbox')} onTest={onTest} />);
    expect(testButton(html)).not.toMatch(/\sdisabled=""/);
  });

  it('disables Test connection for a connected live connector and points to the authenticated API', () => {
    const live = sourceById('kubernetes');
    expect(live.configured).toBe(true);
    const html = renderToStaticMarkup(<ConnectorCard source={live} onTest={onTest} />);
    expect(testButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain('GET /api/v1/connectors?probe=true');
  });
});

// ---------------------------------------------------------------------------
// Walk mode — connect → ingest → data-lands → disconnect
// ---------------------------------------------------------------------------

import { FocusFileAdapter } from '@/costsource';
import { currentMonthWindow, type ConnectorSession, type IngestRun } from './ingestLanding';
import { rawRowsForVersion } from '@/costsource/seed';

const noOp = () => {};

function landedRun(sourceId = 'pointfive-sandbox'): IngestRun {
  return {
    sourceId,
    sourceName: 'PointFive (sandbox)',
    at: '2026-06-01T14:30:00.000Z',
    result: FocusFileAdapter.ingest(
      rawRowsForVersion('1.0'),
      '1.0',
      sourceId,
      currentMonthWindow(),
    ),
    findings: [],
  };
}

describe('ConnectorCard — walk mode', () => {
  it('renders Connect for a closed session and drops the registry Test button', () => {
    const html = renderToStaticMarkup(
      <ConnectorCard source={sourceById('pointfive-sandbox')} onConnect={noOp} />,
    );
    expect(html).toContain('>Connect</button>');
    expect(html).not.toContain('Test connection');
  });

  it('renders Ingest + Disconnect for an open session', () => {
    const session: ConnectorSession = { state: 'open', openedAt: '2026-06-01T14:29:00.000Z' };
    const html = renderToStaticMarkup(
      <ConnectorCard
        source={sourceById('pointfive-sandbox')}
        session={session}
        onConnect={noOp}
        onIngest={noOp}
        onDisconnect={noOp}
      />,
    );
    expect(html).toContain('Ingest now');
    expect(html).toContain('Disconnect');
  });

  it('renders Retry connect with the seam error verbatim after a failure', () => {
    const session: ConnectorSession = {
      state: 'error',
      error: 'Adapter is not configured — no credentials in the environment',
      openedAt: '2026-06-01T14:29:00.000Z',
    };
    const html = renderToStaticMarkup(
      <ConnectorCard source={sourceById('pointfive-sandbox')} session={session} onConnect={noOp} />,
    );
    expect(html).toContain('Retry connect');
    expect(html).toContain('Adapter is not configured — no credentials in the environment');
  });

  it('renders the landed-data verification with real ingested rows', () => {
    const session: ConnectorSession = { state: 'open', openedAt: '2026-06-01T14:29:00.000Z' };
    const html = renderToStaticMarkup(
      <ConnectorCard
        source={sourceById('pointfive-sandbox')}
        session={session}
        run={landedRun()}
        onConnect={noOp}
        onIngest={noOp}
        onDisconnect={noOp}
      />,
    );
    expect(html).toContain('Data landed');
    expect(html).toContain('seeded demo');
    // Re-ingest is offered once data has landed.
    expect(html).toContain('Re-ingest');
    expect(html).toContain('Disconnect');
  });
});
