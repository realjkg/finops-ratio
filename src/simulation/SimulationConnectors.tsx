import Link from 'next/link';
import { useStore } from '@/store/useStore';
import { SIM_SOURCES } from './types';
import { formatRatio, formatUSD } from '@/lib/format';
export function SimulationConnectors() {
  const sim = useStore(s => s.simulation);
  const busy = useStore(s => s.simulationBusy);
  const run = useStore(s => s.simulationCommand);
  if (!sim) return null;
  const value = sim.state.workloads.reduce((n, w) => n + w.value.total_value, 0);
  const total = sim.state.ledger.reduce((n, r) => n + r.cents, 0) / 100;
  return <div className="h-full overflow-auto p-5 sm:p-8"><div className="mx-auto max-w-5xl"><h1 className="text-2xl font-semibold">Connectors</h1><p className="mt-3 text-sm text-sub">Simulated AWS, Azure and GCP charges for {sim.session.identity.tenant}. Each import saves the source, billing date and workload attribution. No cloud credentials are requested.</p><div className="mt-7 grid gap-4 sm:grid-cols-3">{SIM_SOURCES.map(source => {
    const imported = sim.state.imports.includes(`fixture-june-v1:${source}`);
    const rows = sim.state.ledger.filter(r => r.source === source);
    return <section key={source} className="rounded-lg border border-edge bg-deep p-5"><h2 className="text-xl uppercase">{source}</h2><p className="mt-2 text-unit">Connected to local fixture</p><p className="mt-4 font-mono">{formatUSD(rows.reduce((n, r) => n + r.cents, 0) / 100)}</p><p className="mt-1 text-xs text-sub">{rows.length} charge rows · USD</p><p className="mt-2 text-xs text-sub">{formatRatio(value / total)} portfolio value ratio</p><button disabled={busy || sim.session.identity.persona !== 'technical'} className="sim-button mt-5" onClick={() => void run({ type: 'sync', source })}>Import {source.toUpperCase()} fixture</button><p className="mt-3 text-xs text-sub">{imported ? 'Imported. Repeating this action does not duplicate charges.' : 'A fixed late-charge fixture is ready to import.'}</p></section>;
  })}</div><p className="mt-5 text-sm text-sub">Imports require the Technical identity. Real connector authentication and billing validation follow in dev mode.</p><Link className="mt-5 inline-block text-unit underline" href="/workspace">Inspect reconciliation and audit trail</Link></div></div>;
}
