// Frameworks — Wave 4 Slice 4. Governance gates object.
// Presents the four sequential gates (Policy → Ethics → Cost → Scale) with each
// gate's checks from .obvious/obvious.md, per-workload gate status derived from
// existing governance data, and enforcement rules. No new backend, no new deps.

import { useStore } from '@/store/useStore';
import { GATE_DEFS, deriveGateStatus } from '@/frameworks/governanceModel';
import { WorkloadGateRow } from '@/frameworks/WorkloadGateRow';

export default function Frameworks() {
  const workloads = useStore((s) => s.workloads);

  // Summary counts derived from existing governance data.
  const authorizedCount = workloads.filter((w) => deriveGateStatus(w).allPassed).length;
  const blockedAlwaysOn = workloads.filter((w) => deriveGateStatus(w).alwaysOnConflict).length;

  return (
    <div className="flex h-full flex-col bg-void font-body text-txt">
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
          {/* Page header */}
          <div className="mb-6">
            <h1 className="font-mono text-lg font-bold text-txt">Frameworks</h1>
            <p className="mt-1 text-sm text-sub">
              Four sequential governance gates. Gate N+1 cannot pass without Gate N.
            </p>
          </div>

          {/* Summary strip */}
          <div className="mb-8 flex flex-wrap gap-3">
            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Authorized</div>
              <div className="mt-0.5 font-mono text-xl font-bold" style={{ color: 'var(--value)' }}>
                {authorizedCount}
                <span className="ml-1 text-sm font-normal text-sub">/ {workloads.length}</span>
              </div>
            </div>
            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Shape conflicts</div>
              <div
                className="mt-0.5 font-mono text-xl font-bold"
                style={{ color: blockedAlwaysOn > 0 ? 'var(--shape)' : 'var(--dim)' }}
              >
                {blockedAlwaysOn}
                <span className="ml-1 text-sm font-normal text-sub">always-on blocked</span>
              </div>
            </div>
          </div>

          {/* Gate definitions — horizontal sequential flow */}
          <section className="mb-8">
            <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
              Gate sequence
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {GATE_DEFS.map((gate, idx) => (
                <div key={gate.id} className="relative">
                  {/* Flow arrow connecting gates (desktop only) */}
                  {idx < GATE_DEFS.length - 1 && (
                    <div
                      className="absolute right-0 top-6 hidden h-px w-3 lg:block"
                      style={{
                        background: 'var(--gate)',
                        opacity: 0.25,
                        transform: 'translateX(100%)',
                      }}
                    />
                  )}
                  <div
                    className="h-full rounded-card border p-3"
                    style={{
                      borderColor: 'rgba(124,141,255,0.25)',
                      background: 'rgba(124,141,255,0.04)',
                    }}
                  >
                    {/* Gate number + label */}
                    <div className="mb-2.5 flex items-center gap-2">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold"
                        style={{
                          background: 'rgba(124,141,255,0.18)',
                          color: 'var(--gate)',
                        }}
                      >
                        {gate.gateNumber}
                      </span>
                      <span
                        className="font-mono text-[11px] font-bold uppercase tracking-wider"
                        style={{ color: 'var(--gate)' }}
                      >
                        {gate.label}
                      </span>
                    </div>
                    {/* Checks */}
                    <ul className="space-y-1">
                      {gate.checks.map((check) => (
                        <li key={check} className="flex items-start gap-1.5 text-[11px] text-sub">
                          <span className="mt-0.5 shrink-0 text-dim">·</span>
                          <span>{check}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Per-workload gate status table */}
          <section className="mb-8">
            <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
              Workload gate status
            </h2>
            <div className="overflow-hidden rounded-card border border-edge">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-edge bg-deep">
                    <th className="py-2 pl-4 pr-4 font-mono text-[10px] uppercase tracking-wider text-dim">
                      Workload
                    </th>
                    {GATE_DEFS.map((gate) => (
                      <th
                        key={gate.id}
                        className="py-2 pr-2 text-center font-mono text-[10px] uppercase tracking-wider"
                        style={{ color: 'var(--gate)' }}
                        title={`Gate ${gate.gateNumber} · ${gate.label}`}
                      >
                        G{gate.gateNumber}
                      </th>
                    ))}
                    <th className="py-2 pr-3 text-center font-mono text-[10px] uppercase tracking-wider text-dim">
                      Gates
                    </th>
                    <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-dim">
                      Status
                    </th>
                    <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wider text-dim">
                      Demand
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {workloads.map((w) => (
                    <WorkloadGateRow key={w.id} workload={w} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Enforcement rules */}
          <section>
            <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-sub">
              Enforcement rules
            </h2>
            <div className="rounded-card border border-edge bg-slab">
              <ul className="divide-y divide-edge">
                <li className="flex items-start gap-3 px-4 py-3">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--gate)' }}
                  >
                    G1–G4
                  </span>
                  <p className="text-[12px] text-sub">
                    Gates are sequential. Gate N+1 cannot be approved until all gates 1–N pass.
                    Revoking a gate cascades — later gates are implicitly unset.
                  </p>
                </li>
                <li className="flex items-start gap-3 px-4 py-3">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--shape)' }}
                  >
                    G4 REQ
                  </span>
                  <p className="text-[12px] text-sub">
                    A &gt;3× inference-volume increase without Gate 4 (Scale) automatically
                    throttles the workload to its previous level and fires an alert.
                  </p>
                </li>
                <li className="flex items-start gap-3 px-4 py-3">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--shape)' }}
                  >
                    SHAPE
                  </span>
                  <p className="text-[12px] text-sub">
                    The <span className="font-mono">always_on</span> demand shape is blocked
                    unless all four gates pass. Workloads on <span className="font-mono">always_on</span>{' '}
                    without full gate authorization are flagged above.
                  </p>
                </li>
                <li className="flex items-start gap-3 px-4 py-3">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--gate)' }}
                  >
                    HOURLY
                  </span>
                  <p className="text-[12px] text-sub">
                    Gate status is re-checked on every hourly budget evaluation. A workload
                    that loses gate status mid-cycle is flagged immediately.
                  </p>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

