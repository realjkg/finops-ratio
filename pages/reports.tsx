import Link from 'next/link';
import { useStore } from '@/store/useStore';
import { SnapshotButton } from '@/executive/SnapshotButton';
import { formatRatio, formatUSD } from '@/lib/format';
import { buildReportModel } from '@/executive/reportModel';

export default function Reports() {
  const workloads = useStore(s => s.workloads);
  const budgets = useStore(s => s.budgets);
  const alerts = useStore(s => s.alerts);
  const now = useStore(s => s.now);
  const sim = useStore(s => s.simulation);
  const busy = useStore(s => s.simulationBusy);
  const run = useStore(s => s.simulationCommand);
  const model = buildReportModel(now, workloads, { budgets, alerts, now }, sim ? { records: sim.state.outcomes, ledger: sim.state.ledger } : undefined);
  return <div className="h-full overflow-y-auto p-4 sm:p-8"><div className="mx-auto max-w-6xl space-y-7">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">Reports</h1><p className="mt-2 text-sm text-sub">{sim ? `${sim.session.identity.tenant} · saved revision ${sim.state.revision}` : 'Bundled demo dataset'} · June 2026 · simulated data</p></div><SnapshotButton /></header>
    <p className="text-sm text-sub">Cost, budget consumption and value from one portfolio. Savings opportunities are estimates. PDF and spreadsheet exports are generated on the server{sim ? ' from this saved customer workspace' : ' from the bundled seed; sign in to export your saved changes'}.</p>
    <div className="overflow-x-auto rounded border border-edge"><table className="sim-table"><thead><tr><th>Initiative</th><th>Monthly cost</th><th>Budget consumed</th><th>Value / cost</th><th>Projected opportunity</th><th>Status</th></tr></thead><tbody>{model.rows.map(r => <tr key={r.name}><td>{r.name}</td><td>{formatUSD(r.monthlyCost)}</td><td>{r.budgetConsumedPct}%</td><td>{formatRatio(r.costEfficiency)}</td><td>{formatUSD(r.savingsOpportunity)}</td><td>{r.status}</td></tr>)}</tbody></table></div>
    {model.outcomeReports && <section className="rounded border border-edge bg-deep p-5"><h2 className="text-lg font-semibold">Outcome evidence and full costs</h2><p className="mt-2 text-sm text-sub">Financial returns use reviewed measured benefits and substantiated costs for each initiative’s observation period. The portfolio table above retains its original seeded value assumptions.</p><div className="mt-4 overflow-x-auto"><table className="sim-table"><thead><tr><th>Initiative / owner</th><th>Baseline → observed</th><th>Full cost</th><th>Measured benefit</th><th>Benefit / full cost</th><th>Decision review</th></tr></thead><tbody>{model.outcomeReports.map(({ name, record, result, decisionStale }) => <tr key={record.workloadId}><td>{name}<br /><span className="text-xs text-sub">{record.owner}</span></td><td>{record.baseline.value} → {record.observation.value} {record.unit}</td><td>{result.totalCostCents === null ? 'Incomplete' : formatUSD(result.totalCostCents / 100)}</td><td>{formatUSD(result.measuredBenefitCents / 100)}</td><td>{result.measuredRatio === null ? 'Not established' : formatRatio(result.measuredRatio)}</td><td>{decisionStale ? 'Renew review' : result.recommendation}</td></tr>)}</tbody></table></div><Link className="mt-4 inline-block text-unit underline" href="/outcomes">Review outcome evidence</Link></section>}
    <section className="rounded border border-edge bg-deep p-5"><h2 className="text-lg font-semibold">Delivery preview</h2><p className="mt-2 text-sm text-sub">Record a simulated delivery to review the workflow. Nothing is sent to Slack or email.</p>{sim ? <><div className="mt-4 flex flex-wrap gap-3">{(['email', 'slack'] as const).map(channel => <button key={channel} className="sim-button" disabled={busy} onClick={() => void run({ type: 'simulate-delivery', channel })}>Simulate {channel} delivery</button>)}</div><ul className="mt-4 space-y-2 text-sm text-sub">{sim.state.deliveries.slice(-5).reverse().map(d => <li key={d.id}>{d.channel} · simulated · {d.at}</li>)}</ul></> : <Link className="mt-4 inline-block text-unit underline" href="/simulation">Sign in to save report activity</Link>}</section>
    <nav className="flex flex-wrap gap-5 text-sm text-unit"><Link href="/workspace">Customer workflow</Link><Link href="/outcomes">Initiative outcomes</Link><Link href="/tokenomics">Tokenomics measurement demo</Link><Link href="/attribution">Cost attribution demo</Link><Link href="/prediction">Prediction experiment</Link><Link href="/finio">FinIO exchange</Link></nav>
  </div></div>;
}
