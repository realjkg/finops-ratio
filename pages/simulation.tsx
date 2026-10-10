import Link from 'next/link';
import { useSimulationAccess } from '@/simulation/SimulationProvider';
import { PERSONA_LABELS } from '@/simulation/types';
import { useStore } from '@/store/useStore';
export default function SimulationSignIn() {
  const access = useSimulationAccess();
  const sim = useStore(s => s.simulation);
  return <main className="min-h-screen bg-void px-5 py-12 text-txt"><div className="mx-auto max-w-4xl">
    <Link href="/demo" className="text-sm text-unit underline">Ratio demo</Link>
    <p className="mt-8 text-xs uppercase tracking-widest text-unit">Simulated customer accounts</p>
    <h1 className="mt-3 text-3xl font-semibold">Follow the cost from import to decision.</h1>
    <p className="mt-4 max-w-2xl text-sub">Choose a test identity. Each customer has its own saved workspace. Executive, Technical, and Procurement share the same costs, with different permissions. No password, personal account, or cloud credential is used.</p>
    <p className="mt-3 text-sm text-sub">The identity provider is simulated. Session cookies, expiry, sign-out, tenant separation, authorization, and saved changes run on the server. Sessions expire after one hour.</p>
    {access?.loading && <p role="status" className="mt-8">Loading simulation…</p>}
    {access?.error && <p role="alert" className="mt-6 text-cost">{access.error}</p>}
    {!access?.loading && !access?.enabled && <p className="mt-8 rounded border border-edge p-4">This deployment does not enable customer simulation. Run the repository’s simulation command in the local test environment.</p>}
    {sim && <div className="mt-8 rounded border border-unit/40 p-5"><p>Signed in as {sim.session.identity.user} for {sim.session.identity.tenant}.</p><Link className="mt-3 inline-block rounded bg-gate px-4 py-2 text-void" href="/workspace">Open customer workflow</Link></div>}
    <div className="mt-8 grid gap-4 sm:grid-cols-3">{Object.entries(access?.identities ?? {}).map(([id, identity]) => <section key={id} className="rounded-lg border border-edge bg-deep p-5">
      <p className="text-xs uppercase tracking-widest text-dim">{identity.tenant}</p><h2 className="mt-2 text-lg">{PERSONA_LABELS[identity.persona]}</h2>
      <p className="mt-2 text-sm text-sub">{identity.persona === 'technical' ? 'Import charges, investigate, request and implement approved changes.' : identity.persona === 'executive' ? 'Review value and budget risk, authorize changes and export results.' : 'Compare model costs, fund budgets and approve purchase decisions.'}</p>
      <button disabled={access?.loading} onClick={() => void access?.signIn(id)} className="mt-5 rounded border border-gate px-3 py-2 text-sm text-gate disabled:opacity-40">Continue as {identity.user.split(' ')[0]}</button>
    </section>)}</div>
  </div></main>;
}
