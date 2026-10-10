// FocusDoorWalk — Door 1 (POST /ingest/focus) as a walkable connector. Render
// tests only: the zustand hook serves the store's INITIAL state under a static
// server render (getServerState || getInitialState), so state written in a test
// is invisible to renderToStaticMarkup. The hook is therefore mocked with a
// controllable state holder; the real store walk logic is covered end-to-end in
// connectorWalk.test.ts.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IngestRun } from './ingestLanding';
import { FOCUS_DOOR_WALK_ID, currentMonthWindow } from './ingestLanding';

type Session = { state: 'open' | 'error'; error?: string; openedAt: string };

const walkState = vi.hoisted(() => ({
  connectorSessions: {} as Record<string, Session>,
  ingestRuns: {} as Record<string, IngestRun>,
  connectorBusy: null as { sourceId: string; phase: 'connecting' | 'ingesting' } | null,
  openConnectorSession: (_id: string) => {},
  recordDirectIngest: (_id: string, _run: IngestRun) => {},
  disconnectConnector: (_id: string) => {},
}));

vi.mock('@/store/useStore', () => ({
  useStore: (selector: (s: typeof walkState) => unknown) => selector(walkState),
}));

const { FocusDoorWalk } = await import('./FocusDoorWalk');
const { FocusFileAdapter } = await import('@/costsource');
const { rawRowsForVersion } = await import('@/costsource/seed');

beforeEach(() => {
  walkState.connectorSessions = {};
  walkState.ingestRuns = {};
  walkState.connectorBusy = null;
});

function landedRun(): IngestRun {
  return {
    sourceId: FOCUS_DOOR_WALK_ID,
    sourceName: 'FOCUS direct ingest',
    at: '2026-06-01T14:30:00.000Z',
    result: FocusFileAdapter.ingest(
      rawRowsForVersion('1.1'),
      '1.1',
      FOCUS_DOOR_WALK_ID,
      currentMonthWindow(),
    ),
    findings: [],
  };
}

describe('FocusDoorWalk — render states', () => {
  it('renders a closed door with a Connect action', () => {
    const html = renderToStaticMarkup(<FocusDoorWalk />);
    expect(html).toContain('POST /ingest/focus');
    expect(html).toContain('>Connect</button>');
    expect(html).toContain('Closed');
  });

  it('renders the version picker and ingest action once the door is open', () => {
    walkState.connectorSessions = {
      [FOCUS_DOOR_WALK_ID]: { state: 'open', openedAt: '2026-06-01T14:29:00.000Z' },
    };
    const html = renderToStaticMarkup(<FocusDoorWalk />);
    expect(html).toContain('Open');
    // Configure step: every FOCUS version the shim accepts is selectable.
    expect(html).toContain('Export version (configure)');
    expect(html).toContain('v1.0');
    expect(html).toContain('v1.4');
    expect(html).toContain('Ingest sample rows');
    expect(html).toContain('Close door');
  });

  it('renders the landed-run verification after the door ingests sample rows', () => {
    walkState.connectorSessions = {
      [FOCUS_DOOR_WALK_ID]: { state: 'open', openedAt: '2026-06-01T14:29:00.000Z' },
    };
    walkState.ingestRuns = { [FOCUS_DOOR_WALK_ID]: landedRun() };

    const html = renderToStaticMarkup(<FocusDoorWalk />);
    expect(html).toContain('Data landed');
    expect(html).toContain('seeded demo');
    expect(html).toContain('Re-ingest');
    // The shim audit: a v1.1 export upgraded to the v1.4 canonical model.
    expect(html).toContain('v1.1');
    expect(html).toContain('v1.4');
  });
});
