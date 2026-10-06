import Link from 'next/link';
import { useRouter } from 'next/router';
import { useStore } from '@/store/useStore';
import { useSimulationAccess } from './SimulationProvider';
import { PERSONA_LABELS } from './types';
export function SimulationBar() {
  const { pathname } = useRouter();
  const sandbox = ['/finio', '/finio/demo', '/tokenomics', '/prediction', '/costsource'].includes(pathname);
  const sim = useStore(s => s.simulation);
  const busy = useStore(s => s.simulationBusy);
  const error = useStore(s => s.simulationError);
  const access = useSimulationAccess();
  return <div className="shrink-0 border-b border-edge bg-slab px-3 py-2 text-xs text-sub">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <strong className="text-unit">{sim ? 'Customer simulation' : 'Seeded demo'}</strong>
      {sim ? <>
        <span>{sim.session.identity.tenant} · {sim.session.identity.user} · {PERSONA_LABELS[sim.session.identity.persona]}</span>
        <span role="status">{busy ? 'Saving…' : `Saved · revision ${sim.state.revision}`}</span>
        <Link className="underline" href="/workspace">Customer workflow</Link>
        <button className="underline" disabled={busy || access?.loading} onClick={() => void access?.refresh()}>Refresh</button>
        <button className="underline" disabled={busy || access?.loading} onClick={() => void access?.signOut()}>Sign out</button>
      </> : <><span>Simulated costs and business value</span><Link className="underline" href="/simulation">Customer sign-in simulation</Link></>}
    </div>
    {sim && sandbox && <p className="mt-2">Fixture sandbox: experiments on this screen do not update your saved customer cost ledger.</p>}
    {(error || access?.error) && <p role="alert" className="mt-2 text-cost">{error || access?.error}</p>}
  </div>;
}
