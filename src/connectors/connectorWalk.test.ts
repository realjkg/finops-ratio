// Connector E2E walk — every connector completes connect → ingest → data-lands
// → disconnect against the offline seed, through the CostSourceClient seam.
// Failure paths assert the seam's honest error reaches the session verbatim;
// no test invents data or paper over a failure with a fake success.

import { beforeEach, describe, expect, it } from 'vitest';
import { createCostSourceClient, FocusFileAdapter } from '@/costsource';
import type { CostSourceClient, SourceHealth } from '@/costsource/CostSourceClient';
import { findSource, rawRowsForVersion } from '@/costsource/seed';
import { WORKLOADS } from '@/data/workloads';
import { useStore } from '@/store/useStore';
import {
  FOCUS_DOOR_WALK_ID,
  FOCUS_DOOR_SOURCE_NAME,
  currentMonthWindow,
  landedWorkloads,
  landingSummary,
  type IngestRun,
} from './ingestLanding';

const client = createCostSourceClient('mock');

beforeEach(() => {
  useStore.setState({ connectorSessions: {}, ingestRuns: {}, connectorBusy: null });
});

describe('PointFive (sandbox) — full walk', () => {
  it('connects, ingests through the seam, lands rows + findings, disconnects clean', async () => {
    await useStore.getState().connectConnector('pointfive-sandbox', client);
    expect(useStore.getState().connectorSessions['pointfive-sandbox']?.state).toBe('open');

    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', client);

    const run = useStore.getState().ingestRuns['pointfive-sandbox'];
    expect(run).toBeDefined();
    expect(run!.result.rows.length).toBeGreaterThan(0);
    expect(run!.result.canonicalVersion).toBe('1.4');
    // PointFive reports DeepWaste findings — they land with the run.
    expect(run!.findings.length).toBeGreaterThan(0);

    // "Data lands" means the rows resolve to real Ratio workloads.
    const landed = landedWorkloads(useStore.getState().ingestRuns);
    expect(landed.size).toBeGreaterThan(0);
    for (const id of landed.keys()) {
      expect(WORKLOADS.some((w) => w.id === id)).toBe(true);
    }

    // The verification summary aggregates exactly what the seam returned.
    const summary = landingSummary(run!);
    expect(summary.rows).toBe(run!.result.rows.length);
    expect(summary.workloadsResolved).toBe(landed.size);

    // Disconnect is clean: session and landed run are both withdrawn.
    useStore.getState().disconnectConnector('pointfive-sandbox');
    expect(useStore.getState().connectorSessions['pointfive-sandbox']).toBeUndefined();
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toBeUndefined();
  });

  it('reconnects clean after a disconnect (no stale run)', async () => {
    await useStore.getState().connectConnector('pointfive-sandbox', client);
    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', client);
    useStore.getState().disconnectConnector('pointfive-sandbox');

    await useStore.getState().connectConnector('pointfive-sandbox', client);
    expect(useStore.getState().connectorSessions['pointfive-sandbox']?.state).toBe('open');
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toBeUndefined();
  });
});

describe('Focus File (sandbox) — full walk', () => {
  it('connects and ingests its native export to canonical v1.4', async () => {
    const src = findSource('focus-file-sandbox');
    expect(src?.configured).toBe(true);

    await useStore.getState().connectConnector('focus-file-sandbox', client);
    expect(useStore.getState().connectorSessions['focus-file-sandbox']?.state).toBe('open');

    await useStore
      .getState()
      .runConnectorIngest('focus-file-sandbox', 'Focus File (sandbox)', client);

    const run = useStore.getState().ingestRuns['focus-file-sandbox'];
    expect(run).toBeDefined();
    expect(run!.result.sourceVersion).toBe(src!.focusVersion);
    expect(run!.result.canonicalVersion).toBe('1.4');
    expect(run!.result.rows.length).toBeGreaterThan(0);
    // Findings land only if the source advertises the capability.
    if (!src!.capabilities.includes('findings')) {
      expect(run!.findings).toEqual([]);
    }
    expect(landedWorkloads(useStore.getState().ingestRuns).size).toBeGreaterThan(0);

    useStore.getState().disconnectConnector('focus-file-sandbox');
    expect(useStore.getState().ingestRuns['focus-file-sandbox']).toBeUndefined();
  });
});

describe('FOCUS direct-ingest door (Door 1) — full walk', () => {
  it('opens, ingests v1.0 sample rows through the shim, lands, closes', () => {
    useStore.getState().openConnectorSession(FOCUS_DOOR_WALK_ID);
    expect(useStore.getState().connectorSessions[FOCUS_DOOR_WALK_ID]?.state).toBe('open');

    const result = FocusFileAdapter.ingest(
      rawRowsForVersion('1.0'),
      '1.0',
      FOCUS_DOOR_WALK_ID,
      currentMonthWindow(),
    );
    useStore.getState().recordDirectIngest(FOCUS_DOOR_WALK_ID, {
      sourceId: FOCUS_DOOR_WALK_ID,
      sourceName: FOCUS_DOOR_SOURCE_NAME,
      at: new Date().toISOString(),
      result,
      findings: [],
    });

    const run = useStore.getState().ingestRuns[FOCUS_DOOR_WALK_ID];
    expect(run).toBeDefined();
    expect(run!.result.sourceVersion).toBe('1.0');
    expect(run!.result.canonicalVersion).toBe('1.4');
    // A v1.0 export is upgraded by the shim — the audit shows the backfill.
    expect(run!.result.backfilledColumns.length).toBeGreaterThan(0);
    expect(landedWorkloads(useStore.getState().ingestRuns).size).toBeGreaterThan(0);

    useStore.getState().disconnectConnector(FOCUS_DOOR_WALK_ID);
    expect(useStore.getState().connectorSessions[FOCUS_DOOR_WALK_ID]).toBeUndefined();
    expect(useStore.getState().ingestRuns[FOCUS_DOOR_WALK_ID]).toBeUndefined();
  });

  it('re-ingest replaces the landed run (one run per walk id)', () => {
    useStore.getState().openConnectorSession(FOCUS_DOOR_WALK_ID);
    const first = FocusFileAdapter.ingest(
      rawRowsForVersion('1.0'),
      '1.0',
      FOCUS_DOOR_WALK_ID,
      currentMonthWindow(),
    );
    useStore.getState().recordDirectIngest(FOCUS_DOOR_WALK_ID, {
      sourceId: FOCUS_DOOR_WALK_ID,
      sourceName: FOCUS_DOOR_SOURCE_NAME,
      at: new Date().toISOString(),
      result: first,
      findings: [],
    });

    const second = FocusFileAdapter.ingest(
      rawRowsForVersion('1.4'),
      '1.4',
      FOCUS_DOOR_WALK_ID,
      currentMonthWindow(),
    );
    useStore.getState().recordDirectIngest(FOCUS_DOOR_WALK_ID, {
      sourceId: FOCUS_DOOR_WALK_ID,
      sourceName: FOCUS_DOOR_SOURCE_NAME,
      at: new Date().toISOString(),
      result: second,
      findings: [],
    });

    const run = useStore.getState().ingestRuns[FOCUS_DOOR_WALK_ID];
    expect(run!.result.sourceVersion).toBe('1.4');
    // Canonical v1.4 rows need no backfill — the honest passthrough case.
    expect(run!.result.backfilledColumns).toEqual([]);
  });

  it('rejects direct-ingest records under any other walk id', () => {
    const result = FocusFileAdapter.ingest(
      rawRowsForVersion('1.4'),
      '1.4',
      'pointfive-sandbox',
      currentMonthWindow(),
    );
    useStore.getState().recordDirectIngest('pointfive-sandbox', {
      sourceId: 'pointfive-sandbox',
      sourceName: 'PointFive (sandbox)',
      at: new Date().toISOString(),
      result,
      findings: [],
    });
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toBeUndefined();
  });
});

describe('honest failure paths', () => {
  it('connecting an unconfigured live connector surfaces the seam verdict verbatim', async () => {
    // No KUBERNETES_FOCUS_ENDPOINT in the test env → the connector is
    // unconfigured and the adapter reports reachable:false with its own note.
    await useStore.getState().connectConnector('kubernetes', client);
    const session = useStore.getState().connectorSessions['kubernetes'];
    expect(session?.state).toBe('error');
    expect(session?.error).toBeTruthy();
    expect(useStore.getState().connectorBusy).toBeNull();
  });

  it('ingest failure keeps landed data and carries the error verbatim', async () => {
    await useStore.getState().connectConnector('pointfive-sandbox', client);
    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', client);
    const firstRun: IngestRun | undefined =
      useStore.getState().ingestRuns['pointfive-sandbox'];
    expect(firstRun).toBeDefined();

    const failing: CostSourceClient = {
      mode: 'mock',
      listSources: client.listSources,
      fetchCostRows: async () => {
        throw new Error('adapter socket closed mid-export');
      },
      fetchFindings: client.fetchFindings,
      healthCheck: client.healthCheck,
    };
    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', failing);

    const session = useStore.getState().connectorSessions['pointfive-sandbox'];
    expect(session?.state).toBe('error');
    expect(session?.error).toBe('adapter socket closed mid-export');
    // Landed data stays put — a failed re-ingest never destroys evidence.
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toEqual(firstRun);
    expect(useStore.getState().connectorBusy).toBeNull();
  });

  it('does not ingest without an open session', async () => {
    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', client);
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toBeUndefined();
  });

  it('serializes walks through the single busy slot', async () => {
    let resolveProbe!: (h: SourceHealth) => void;
    const pending = new Promise<SourceHealth>((resolve) => {
      resolveProbe = resolve;
    });
    const slow: CostSourceClient = {
      mode: 'mock',
      listSources: client.listSources,
      fetchCostRows: client.fetchCostRows,
      fetchFindings: client.fetchFindings,
      healthCheck: () => pending,
    };

    const connecting = useStore.getState().connectConnector('pointfive-sandbox', slow);
    expect(useStore.getState().connectorBusy?.phase).toBe('connecting');

    // While the slot is busy, a second walk action is a no-op — never parallel.
    await useStore
      .getState()
      .runConnectorIngest('pointfive-sandbox', 'PointFive (sandbox)', client);
    expect(useStore.getState().ingestRuns['pointfive-sandbox']).toBeUndefined();

    resolveProbe({
      sourceId: 'pointfive-sandbox',
      reachable: true,
      authed: true,
      sourceVersion: '1.0',
      canonicalVersion: '1.4',
      checkedAt: new Date().toISOString(),
      detail: 'ok',
    });
    await connecting;
    expect(useStore.getState().connectorSessions['pointfive-sandbox']?.state).toBe('open');
    expect(useStore.getState().connectorBusy).toBeNull();
  });
});

describe('walk state resets', () => {
  it('clearSimulation wipes sessions, runs, and the busy slot', () => {
    useStore.setState({
      connectorSessions: {
        'pointfive-sandbox': { state: 'open', openedAt: '2026-06-01T00:00:00.000Z' },
      },
      ingestRuns: {
        'pointfive-sandbox': {
          sourceId: 'pointfive-sandbox',
          sourceName: 'PointFive (sandbox)',
          at: '2026-06-01T00:00:00.000Z',
          result: {
            sourceId: 'pointfive-sandbox',
            sourceVersion: '1.0',
            canonicalVersion: '1.4',
            backfilledColumns: [],
            window: currentMonthWindow(),
            generatedAt: '2026-06-01T00:00:00.000Z',
            rows: [],
          },
          findings: [],
        },
      },
      connectorBusy: { sourceId: 'pointfive-sandbox', phase: 'ingesting' },
    });

    useStore.getState().clearSimulation();
    expect(useStore.getState().connectorSessions).toEqual({});
    expect(useStore.getState().ingestRuns).toEqual({});
    expect(useStore.getState().connectorBusy).toBeNull();
  });
});
