// Read-only sample workspace for /simulation when server simulation is off. Local state only:
// nothing here calls the server, reads credentials, or writes to storage (so it does not use
// usePersona, which persists the choice).
import { useState } from 'react';
import { MoneyTable } from '@/connectors/MoneyTable';
import { CONNECTIONS } from '@/demo/apiDatasets';
import { formatMoney, parseUnits, percentRounded, totalsByCurrency, type Reconciled } from '@/demo/apiDatasets/reconcile';
import { importedList, useSampleImports } from '@/demo/apiDatasets/store';
import type { Persona } from '@/lib/persona';
import { SAMPLE_LABEL, SAMPLE_PERSONAS, sampleView } from './sampleWorkspace';

const ORDER: Persona[] = ['executive', 'technical', 'procurement'];

/** The same imported synthetic connections as the Connectors page, through each role's lens. */
function ImportedConnections({ persona }: { persona: Persona }) {
  const { imported, busy, error, importAll } = useSampleImports();
  const list = importedList(imported);
  const loading = CONNECTIONS.some((c) => busy[c.id]);
  return (
    <section aria-label="Imported synthetic connections" className="mt-5 border-t border-edge pt-4">
      <h3 className="text-sm font-semibold">Imported API connections (synthetic)</h3>
      {list.length === 0 ? (
        <>
          <p className="mt-1 text-xs text-sub">Import the public cloud, private cloud and on-premise sample connections to see them here. The data is a bundled file from this site: no data request, nothing saved.</p>
          <button type="button" disabled={loading} onClick={() => void importAll()} className="mt-2 rounded border border-gate px-3 py-1.5 text-xs text-gate disabled:opacity-60">{loading ? 'Importing…' : 'Import the three synthetic connections'}</button>
        </>
      ) : persona === 'executive' ? (
        <div className="mt-2">
          <MoneyTable label="Imported spend by currency" caption="Imported spend, one row per currency" headers={['Currency', 'Billed', 'Effective']}
            rows={totalsByCurrency(list).map((t) => [t.currency, formatMoney(t.billed, t.currency), formatMoney(t.effective, t.currency)])} />
          <p className="mt-1 text-xs text-sub">Currencies are listed separately and never added together.</p>
        </div>
      ) : persona === 'technical' ? (
        <ul className="mt-2 space-y-2 text-sm">{list.map((r: Reconciled) => (
          <li key={r.id}><span className="font-medium">{r.name}</span>
            <span className="block text-xs text-sub">{r.topServices.slice(0, 3).map((x) => `${x.service} ${formatMoney(x.effective, r.currency)}`).join(' · ')}</span></li>))}</ul>
      ) : (
        <ul className="mt-2 space-y-2 text-sm">{list.map((r: Reconciled) => (
          <li key={r.id}><span className="font-medium">{r.name}</span>
            <span className="block text-xs text-sub">{r.commitment
              ? `${r.commitment.name}: ${formatMoney(r.commitment.purchaseBilled, r.currency)} prepaid; this month ${formatMoney(r.commitment.usedEffective, r.currency)} used, ${formatMoney(r.commitment.unusedEffective, r.currency)} unused (${percentRounded(parseUnits(r.commitment.unusedEffective), parseUnits(r.commitment.usedEffective) + parseUnits(r.commitment.unusedEffective))}% unused)`
              : 'No commitment on this connection (owned capacity).'}</span></li>))}</ul>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-cost">{error}</p>}
    </section>
  );
}

export function SampleWorkspace({ degraded = false }: { degraded?: boolean }) {
  const [persona, setPersona] = useState<Persona | null>(null);
  const view = persona ? sampleView(persona) : null;
  return (
    <div className="mt-8">
      <p role="note" className="inline-block rounded border border-unit/40 bg-unit/10 px-3 py-1 font-mono text-xs text-unit">{SAMPLE_LABEL}</p>
      <p className="mt-3 max-w-2xl text-sm text-sub">
        {degraded ? 'The simulation service could not be reached, so this is a read-only sample.' : 'This deployment does not save customer workspaces, so here is a read-only sample.'} Pick a role to see the same synthetic costs through its lens. No sign-in is needed, no data is requested or sent, and it is gone when you close the tab.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {ORDER.map((p) => (
          <section key={p} className="flex flex-col rounded-lg border border-edge bg-deep p-5">
            <p className="text-xs uppercase tracking-widest text-dim">Sample</p>
            <h2 className="mt-2 text-lg">{SAMPLE_PERSONAS[p].title}</h2>
            <p className="mt-2 flex-1 text-sm text-sub">{SAMPLE_PERSONAS[p].blurb}</p>
            <button type="button" aria-pressed={persona === p} onClick={() => setPersona(p)} className="mt-5 rounded border border-gate px-3 py-2 text-sm text-gate aria-pressed:bg-gate aria-pressed:text-void">
              {persona === p ? `Viewing ${SAMPLE_PERSONAS[p].title}` : `Open ${SAMPLE_PERSONAS[p].title} sample`}
            </button>
          </section>
        ))}
      </div>
      {view && (
        <section aria-label={`Sample workspace: ${SAMPLE_PERSONAS[view.persona].title}`} className="mt-6 rounded-lg border border-edge bg-slab p-5">
          <dl className="grid gap-3 sm:grid-cols-3">
            {view.stats.map((s) => (
              <div key={s.label} className="rounded border border-edge bg-deep p-3">
                <dt className="text-xs text-sub">{s.label}</dt>
                <dd className="mt-1 font-mono text-lg tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 text-sm font-semibold">{view.heading}</h3>
          <ul className="mt-2 divide-y divide-edge">
            {view.rows.map((r) => (
              <li key={r.label} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0"><span className="block break-words">{r.label}</span><span className="block break-words text-xs text-sub">{r.detail}</span></span>
                <span className={`shrink-0 font-mono tabular-nums ${r.flag === 'risk' ? 'text-cost' : ''}`}>{r.value}{r.flag === 'risk' ? ' (watch)' : ''}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-sub">{view.note}</p>
          <ImportedConnections persona={view.persona} />
        </section>
      )}
    </div>
  );
}
