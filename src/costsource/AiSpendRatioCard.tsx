// AI spend vs total spend card for /costsource. A two-way switch picks the
// data path: 'Static seed' (mock client: offline sandbox + synthetic sources)
// or 'Ingested' (live client over the existing /api/costsource routes). Both
// run the same fetchAiSpendRatio; only the client differs. Component state
// only; nothing is remembered.
import { useEffect, useState } from 'react';
import { createCostSourceClient } from './index';
import { LiveDataAuthError } from './LiveCostSourceClient';
import { isOfflineSandboxSource } from './sandboxSources';
import { fetchAiSpendRatio } from './aiSpendRatio';
import type { AiSpendRatio, AiSpendRatioReport } from './aiSpendRatio';
import type { CostWindow } from './CostSourceClient';
import { formatUSD } from '@/lib/format';

type RatioPath = 'seed' | 'ingested';
type RatioState =
  | { status: 'loading' }
  | { status: 'ready'; report: AiSpendRatioReport }
  | { status: 'unavailable'; reason: string; errors?: AiSpendRatioReport['errors'] };

const PATH_LABEL: Record<RatioPath, string> = { seed: 'Static seed', ingested: 'Ingested' };
const PATH_DETAIL: Record<RatioPath, string> = {
  seed: 'mock client: offline sandbox + synthetic sources',
  ingested: 'live client: /api/costsource routes, non-sandbox sources only',
};

/** Load the ratio for one path; never throws (failures become 'unavailable'). */
export async function loadAiSpendRatio(path: RatioPath, window: CostWindow): Promise<RatioState> {
  try {
    const client = createCostSourceClient(path === 'seed' ? 'mock' : 'live');
    let sourceIds: string[] | undefined;
    if (path === 'ingested') {
      // Offline sandbox sources serve seed data even over the live routes, so
      // they never count as ingested.
      sourceIds = (await client.listSources())
        .filter((s) => s.configured && s.capabilities.includes('costRows') && !isOfflineSandboxSource(s.id))
        .map((s) => s.id);
      if (sourceIds.length === 0) {
        return {
          status: 'unavailable',
          reason: 'No ingested sources connected: the live routes expose only offline sandbox (seed) sources here.',
        };
      }
    }
    const report = await fetchAiSpendRatio(client, window, sourceIds);
    if (report.perSource.length === 0) {
      const reason = report.errors.length ? 'No source returned cost rows' : 'No configured cost sources';
      return { status: 'unavailable', reason, errors: report.errors };
    }
    if (report.overall.rowCount + report.overall.excludedRows === 0) {
      return { status: 'unavailable', reason: 'Sources returned no cost rows for this window', errors: report.errors };
    }
    return { status: 'ready', report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'unavailable',
      reason: err instanceof LiveDataAuthError ? `Authentication required: ${message}` : message,
    };
  }
}

/** USD through formatUSD; any other currency as a plain amount plus its code. */
function money(value: number, currency: string): string {
  if (currency === 'USD') return formatUSD(value);
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const pct = (ratio: number | null) => (ratio === null ? 'n/a' : `${(ratio * 100).toFixed(1)}%`);

function CurrencyLines({ result }: { result: AiSpendRatio }) {
  return (
    <>
      {result.byCurrency.map((c) => (
        <span key={c.currency} className="mr-4 font-mono text-xs">
          <span className="text-value">{money(c.aiCost, c.currency)}</span>
          <span className="text-dim"> AI of </span>
          <span className="text-cost">{money(c.totalCost, c.currency)}</span>
          <span className="text-txt"> = {pct(c.ratio)}</span>
        </span>
      ))}
    </>
  );
}

export function AiSpendRatioView({
  path,
  state,
  onSwitch,
}: {
  path: RatioPath;
  state: RatioState;
  onSwitch: (path: RatioPath) => void;
}) {
  return (
    <div className="mb-6 rounded-card border border-edge bg-slab p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-txt">AI spend vs total spend</h2>
        <div className="flex gap-2">
          {(['seed', 'ingested'] as const).map((p) => (
            <button
              key={p}
              onClick={() => onSwitch(p)}
              aria-pressed={path === p}
              className={[
                'rounded-card border px-3 py-1 text-xs font-medium',
                path === p ? 'border-gate bg-gate/10 text-gate' : 'border-edge bg-raised text-sub hover:text-txt',
              ].join(' ')}
            >
              {PATH_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-xs text-sub">
        Path: <span className="font-semibold text-txt">{PATH_LABEL[path]}</span> ({PATH_DETAIL[path]})
        {state.status === 'ready' && ` · client mode: ${state.report.mode}`}
      </p>

      {state.status === 'loading' && <p className="text-xs text-dim">Loading AI spend ratio…</p>}

      {state.status === 'unavailable' && (
        <div className="rounded-card border border-cost/40 bg-cost/10 p-3">
          <p className="text-sm font-medium text-cost">{PATH_LABEL[path]} data unavailable</p>
          <p className="mt-1 text-xs text-sub">{state.reason}</p>
          {state.errors?.map((e) => (
            <p key={e.sourceId} className="text-xs text-dim">{e.sourceId}: {e.message}</p>
          ))}
          {path === 'ingested' && (
            <button onClick={() => onSwitch('seed')} className="mt-2 text-xs text-gate underline">
              Switch to Static seed
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && (
        <div className="space-y-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-dim">Headline (non-overlapping sources)</p>
            <CurrencyLines result={state.report.overall} />
          </div>
          <ul className="space-y-1">
            {state.report.perSource.map((s) => (
              <li key={s.sourceId} className="flex flex-wrap justify-between gap-2 border-t border-edge pt-1">
                <span className="text-xs text-txt">
                  {s.name}
                  {!s.inHeadline && <span className="text-dim"> (same workloads, not summed into the headline)</span>}
                </span>
                <span><CurrencyLines result={s.result} /></span>
              </li>
            ))}
          </ul>
          {state.report.errors.map((e) => (
            <p key={e.sourceId} className="text-xs text-cost">{e.sourceId}: {e.message}</p>
          ))}
          {state.report.overall.notes.map((n) => (
            <p key={n} className="text-xs text-dim">{n}</p>
          ))}
          <p className="text-xs text-dim">
            Basis: EffectiveCost (amortized, credits net in). AI = ServiceCategory “AI and Machine
            Learning”. The headline sums only sources that do not repeat another fetched source’s
            bill; other sources are assumed not to overlap (no row-level dedupe).
          </p>
        </div>
      )}
    </div>
  );
}

export function AiSpendRatioCard() {
  const [path, setPath] = useState<RatioPath>('seed');
  const [state, setState] = useState<RatioState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const window = {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    };
    setState({ status: 'loading' });
    void loadAiSpendRatio(path, window).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return <AiSpendRatioView path={path} state={state} onSwitch={setPath} />;
}
