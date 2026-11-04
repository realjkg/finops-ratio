// WorkloadGateRow — a single <tr> in the workload gate status table.
// Shows gate pass/fail dots, blocked status, demand-shape conflicts, and the
// first blocking gate. Pure presentational; all derivation is in governanceModel.

import type { Workload } from '@/types';
import { GATE_DEFS, deriveGateStatus } from './governanceModel';

const ENV_LABEL: Record<Workload['environment'], string> = {
  prod: 'prod',
  staging: 'stg',
  dev: 'dev',
  sandbox: 'sbx',
};

const DEMAND_LABEL: Record<Workload['demand_shape'], string> = {
  always_on: 'Always-on',
  business_hours: 'Business hrs',
  throttled: 'Throttled',
  batch_offpeak: 'Batch off-peak',
  paused: 'Paused',
  unmanaged: 'Unmanaged',
};

export function WorkloadGateRow({ workload }: { workload: Workload }) {
  const { gatesPassed, allPassed, blockingGate, alwaysOnConflict } =
    deriveGateStatus(workload);

  return (
    <tr className="border-b border-edge last:border-0 motion-safe:transition-colors hover:bg-raised/30">
      {/* Workload name + env · team */}
      <td className="py-2.5 pl-4 pr-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-txt">{workload.name}</span>
          {alwaysOnConflict && (
            <span
              className="rounded px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider"
              style={{
                color: 'var(--shape)',
                background: 'rgba(255,196,77,0.1)',
                border: '1px solid rgba(255,196,77,0.25)',
              }}
              title="Runs always-on without all four gates passed: policy blocks always-on until they pass"
            >
              always-on conflict
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-dim">
          <span>{ENV_LABEL[workload.environment] ?? workload.environment}</span>
          <span>·</span>
          <span>{workload.team}</span>
        </div>
      </td>

      {/* Gate dots: G1 G2 G3 G4 */}
      {GATE_DEFS.map((gate, idx) => {
        const passed = Boolean(workload.governance[gate.govKey]);
        // A gate is locked if any earlier gate has not passed (sequential enforcement).
        const locked =
          !passed && GATE_DEFS.slice(0, idx).some((g) => !workload.governance[g.govKey]);

        return (
          <td key={gate.id} className="py-2.5 pr-2 text-center">
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[10px] font-bold"
              title={
                passed
                  ? `Gate ${gate.gateNumber} ${gate.label} — passed`
                  : locked
                  ? `Gate ${gate.gateNumber} ${gate.label} — locked (prior gate not cleared)`
                  : `Gate ${gate.gateNumber} ${gate.label} — not yet reviewed`
              }
              style={{
                color: passed ? 'var(--gate)' : 'var(--dim)',
                background: passed ? 'rgba(124,141,255,0.12)' : 'transparent',
                border: passed
                  ? '1px solid rgba(124,141,255,0.3)'
                  : '1px solid rgba(77,90,114,0.3)',
              }}
            >
              {passed ? '✓' : locked ? '–' : '·'}
            </span>
          </td>
        );
      })}

      {/* Gates passed counter */}
      <td className="py-2.5 pr-3 text-center">
        <span
          className="font-mono text-sm font-bold"
          style={{ color: allPassed ? 'var(--value)' : 'var(--sub)' }}
        >
          {gatesPassed}/4
        </span>
      </td>

      {/* Status — authorized | awaiting gate N */}
      <td className="py-2.5 pr-3">
        {allPassed ? (
          <span
            className="font-mono text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--value)' }}
          >
            Approved
          </span>
        ) : blockingGate ? (
          <span className="font-mono text-[11px] text-sub">
            Awaiting Gate {blockingGate.gateNumber} · {blockingGate.label}
          </span>
        ) : null}
      </td>

      {/* Demand shape — amber if always_on conflict, red if unmanaged + not authorized */}
      <td className="py-2.5 pr-4">
        <span
          className="font-mono text-[11px]"
          style={{
            color:
              alwaysOnConflict
                ? 'var(--shape)'
                : workload.demand_shape === 'unmanaged' && !allPassed
                ? 'var(--cost)'
                : 'var(--sub)',
          }}
        >
          {DEMAND_LABEL[workload.demand_shape] ?? workload.demand_shape}
        </span>
      </td>
    </tr>
  );
}

