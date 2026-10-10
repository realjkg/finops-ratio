// FocusDoorWalk — Door 1 (direct FOCUS ingest, POST /ingest/focus) as a
// walkable connector. Its "configure" step is the FOCUS version the caller's
// billing tool exports; ingest runs the same FocusFileAdapter the POST route
// runs (pure, in-process, offline). Rows land through the same store slice as
// the adapter ingests, so the door completes the identical connect → ingest →
// data-lands → disconnect walk. Honest by construction: the sample rows are
// the bundled seed (rawRowsForVersion), labeled as such.

import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { FocusFileAdapter, FOCUS_VERSIONS } from '@/costsource';
import type { FocusVersion } from '@/costsource';
import { rawRowsForVersion } from '@/costsource/seed';
import {
  FOCUS_DOOR_WALK_ID,
  FOCUS_DOOR_SOURCE_NAME,
  currentMonthWindow,
} from './ingestLanding';
import { IngestVerification } from './IngestVerification';

export function FocusDoorWalk() {
  const session = useStore((s) => s.connectorSessions[FOCUS_DOOR_WALK_ID]);
  const run = useStore((s) => s.ingestRuns[FOCUS_DOOR_WALK_ID]);
  const busy = useStore((s) => s.connectorBusy);
  const openSession = useStore((s) => s.openConnectorSession);
  const recordRun = useStore((s) => s.recordDirectIngest);
  const disconnect = useStore((s) => s.disconnectConnector);
  const [version, setVersion] = useState<FocusVersion>('1.0');

  // The door walk owns no shared busy slot (its ingest is in-process and
  // instant); the shared slot belongs to the adapter cards.
  const doorBusy = busy?.sourceId === FOCUS_DOOR_WALK_ID;

  function ingest() {
    const result = FocusFileAdapter.ingest(
      rawRowsForVersion(version),
      version,
      FOCUS_DOOR_WALK_ID,
      currentMonthWindow(),
    );
    recordRun(FOCUS_DOOR_WALK_ID, {
      sourceId: FOCUS_DOOR_WALK_ID,
      sourceName: FOCUS_DOOR_SOURCE_NAME,
      at: new Date().toISOString(),
      result,
      findings: [], // the door serves cost rows; findings come from adapters
    });
  }

  return (
    <div
      className="rounded-card border p-4"
      style={{
        borderColor:
          session?.state === 'open' ? 'rgba(0,224,158,0.35)' : 'rgba(124,141,255,0.25)',
        background:
          session?.state === 'open' ? 'rgba(0,224,158,0.04)' : 'rgba(124,141,255,0.04)',
      }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--gate)' }}>
          Door 1 · Direct ingest
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: session?.state === 'open' ? 'var(--value)' : 'var(--dim)' }}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{ color: session?.state === 'open' ? 'var(--value)' : 'var(--dim)' }}
          >
            {session?.state === 'open' ? 'Open' : 'Closed'}
          </span>
        </div>
      </div>
      <div className="font-mono text-sm font-bold text-txt">POST /ingest/focus</div>
      <p className="mt-1.5 text-[12px] text-sub">
        Any FOCUS-formatted billing export (v1.0–v1.4). Any cloud, any tool, any
        normalizer — no custom integration. The version shim upgrades the export to
        the v1.4 canonical model.
      </p>

      {/* Configure step — the export version, then the walk. */}
      {session?.state === 'open' ? (
        <div className="mt-3 space-y-3">
          <div className="rounded border border-edge bg-deep px-2.5 py-2">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-sub">
              Export version (configure)
            </div>
            <div className="flex flex-wrap gap-1">
              {FOCUS_VERSIONS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVersion(v)}
                  className={[
                    'rounded border px-2 py-0.5 font-mono text-[10px] transition-colors',
                    version === v
                      ? 'border-gate bg-gate/20 text-gate'
                      : 'border-edge bg-raised text-sub hover:text-txt',
                  ].join(' ')}
                >
                  v{v}
                </button>
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[10px] text-dim">
              Demo walk ingests the bundled sample rows at v{version}; the live door
              accepts real exports at POST /api/costsource/ingest.
            </p>
          </div>

          {run && <IngestVerification run={run} sandbox={true} />}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={ingest}
              className="rounded border border-value/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-value hover:bg-value/10"
            >
              {run ? 'Re-ingest' : 'Ingest sample rows'}
            </button>
            <button
              type="button"
              onClick={() => disconnect(FOCUS_DOOR_WALK_ID)}
              className="rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-dim hover:text-sub"
            >
              Close door
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => openSession(FOCUS_DOOR_WALK_ID)}
            disabled={doorBusy}
            className="rounded border border-value/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-value hover:bg-value/10 disabled:opacity-60"
          >
            Connect
          </button>
          <p className="mt-1.5 font-mono text-[10px] text-dim">
            No external dependency to probe — the door runs in-process; connect
            opens it to ingests.
          </p>
        </div>
      )}
    </div>
  );
}
