// The demo's three SIMULATED API connections (public cloud, private cloud, on-premise). Nothing here
// connects to anything: "Import sample" loads a committed synthetic FOCUS 1.0 fixture in the browser
// and reconciles it exactly. There is no field for a credential, endpoint or token.
import { CONNECTIONS } from '@/demo/apiDatasets';
import { formatMoney, totalsByCurrency, type Reconciled } from '@/demo/apiDatasets/reconcile';
import { importedList, useSampleImports } from '@/demo/apiDatasets/store';

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const th = 'px-2 py-1 text-left text-xs font-medium text-sub';
const td = 'whitespace-nowrap px-2 py-1 font-mono text-xs tabular-nums';

function Reconciliation({ r }: { r: Reconciled }) {
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p role="status" className={r.matchesControl ? 'text-value' : 'text-cost'}>
        {r.matchesControl ? 'Reconciled: rows, billed and effective match the fixture’s control totals.' : 'Mismatch with the fixture’s control totals.'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[18rem]" aria-label={`Reconciliation, ${r.name}`}>
          <thead><tr><th scope="col" className={th}>Rows</th><th scope="col" className={th}>Billed</th><th scope="col" className={th}>Effective</th><th scope="col" className={th}>Billed − Effective</th></tr></thead>
          <tbody><tr><td className={td}>{r.rows}</td><td className={td}>{formatMoney(r.billed, r.currency)}</td><td className={td}>{formatMoney(r.effective, r.currency)}</td><td className={td}>{formatMoney(r.difference, r.currency)}</td></tr></tbody>
        </table>
      </div>
      <details>
        <summary className="cursor-pointer text-sub">N/A columns ({r.naColumns.length}): empty means not provided, never 0</summary>
        <ul className="mt-1 space-y-0.5 text-sub">
          {r.naColumns.map((c) => <li key={c.column}><span className="font-mono">{c.column}</span>: N/A on {c.rows} of {r.rows} rows. {c.reason}.</li>)}
        </ul>
      </details>
    </div>
  );
}

export function SyntheticApiConnections() {
  const { imported, busy, error, importOne, remove } = useSampleImports();
  const list = importedList(imported);
  const totals = totalsByCurrency(list);
  return (
    <section aria-labelledby="synthetic-connections-heading" className="mb-8">
      <h2 id="synthetic-connections-heading" className="mb-1 font-mono text-[11px] uppercase tracking-wider text-sub">Simulated API connections · Synthetic</h2>
      <p className="mb-3 max-w-3xl text-sm text-sub">
        Three kinds of API connection with fictional data in FOCUS 1.0 form. Nothing connects: Import sample reads a bundled fixture in this tab, makes no network call, and keeps nothing after you leave. Each connection has its own currency, and currencies are never added together.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {CONNECTIONS.map((c) => {
          const r = imported[c.id];
          return (
            <article key={c.id} className="flex min-w-0 flex-col rounded-card border border-edge bg-slab p-4" aria-label={c.name}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-unit/40 bg-unit/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-unit">Synthetic</span>
                <span className="text-xs text-sub">{c.typeLabel}</span>
              </div>
              <h3 className="mt-2 break-words text-sm font-semibold text-txt">{c.name}</h3>
              <p className="mt-1 text-xs text-sub">{c.apiStyle}</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-sub">Last import</dt><dd>{utc(c.lastImport)} (simulated)</dd>
                <dt className="text-sub">Billing period</dt><dd>2026-09</dd>
                <dt className="text-sub">Rows</dt><dd className="font-mono tabular-nums">{c.rowCount} ready</dd>
                <dt className="text-sub">Currency</dt><dd className="font-mono">{c.currency}</dd>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy[c.id]} onClick={() => void importOne(c.id)} className="rounded border border-gate px-3 py-1.5 text-xs text-gate disabled:opacity-60">
                  {busy[c.id] ? 'Importing…' : r ? 'Import again' : 'Import sample'}
                </button>
                {r && <button type="button" onClick={() => remove(c.id)} className="rounded border border-edge px-3 py-1.5 text-xs text-sub">Remove</button>}
              </div>
              {r && <Reconciliation r={r} />}
            </article>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-cost">{error}</p>}
      {totals.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-card border border-edge bg-slab p-3">
          <table className="w-full min-w-[22rem]" aria-label="Imported totals by currency">
            <caption className="pb-1 text-left text-xs text-sub">Imported totals, one line per currency (synthetic)</caption>
            <thead><tr><th scope="col" className={th}>Currency</th><th scope="col" className={th}>Connections</th><th scope="col" className={th}>Rows</th><th scope="col" className={th}>Billed</th><th scope="col" className={th}>Effective</th></tr></thead>
            <tbody>
              {totals.map((t) => <tr key={t.currency}><td className={td}>{t.currency}</td><td className={td}>{t.connections}</td><td className={td}>{t.rows}</td><td className={td}>{formatMoney(t.billed, t.currency)}</td><td className={td}>{formatMoney(t.effective, t.currency)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
