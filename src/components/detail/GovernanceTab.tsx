// Governance Gates tab — spec §5. Sequential 4-gate checklist: a gate can only be
// approved once all prior gates pass; revoking one cascades to later gates. The
// enforcement lives in the store; this view renders + drives it.

import type { GovernanceGateId, Workload } from '@/types';
import { useStore } from '@/store/useStore';
import { allGatesPassed, governanceGatesPassed } from '@/lib/derive';

interface GateDef {
  id: GovernanceGateId;
  key: keyof Workload['governance'];
  title: string;
  question: string;
  detail: string;
}

const GATES: GateDef[] = [
  {
    id: 'policy',
    key: 'policy_check',
    title: 'Gate 1 · Policy',
    question: 'Model allowed?',
    detail: 'Model is on the approved list, region is allowed, resource limits within policy.',
  },
  {
    id: 'ethics',
    key: 'ethics_review',
    title: 'Gate 2 · Ethics',
    question: 'Bias / PII safe?',
    detail: 'Bias audit complete, PII handling documented, output safety review passed.',
  },
  {
    id: 'cost',
    key: 'cost_approval',
    title: 'Gate 3 · Cost',
    question: 'Within budget? Value / cost OK?',
    detail: 'Monthly budget set, Value / cost meets the 3× target, ROI projection documented.',
  },
  {
    id: 'scale',
    key: 'scale_authorized',
    title: 'Gate 4 · Scale',
    question: 'Cleared for production volume?',
    detail: 'All prior gates passed and scale authorization granted by the PO or approver.',
  },
];

export function GovernanceTab({ workload }: { workload: Workload }) {
  const toggleGate = useStore((s) => s.toggleGate);
  const passedCount = governanceGatesPassed(workload);
  const canScale = allGatesPassed(workload);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-card border border-edge bg-slab px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-dim">Gates passed</div>
          <div className="font-mono text-lg font-bold text-txt">{passedCount} / 4</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-dim">Can scale</div>
          <div
            className="font-mono text-sm font-bold uppercase"
            style={{ color: canScale ? 'var(--value)' : 'var(--cost)' }}
          >
            {canScale ? 'Authorized' : 'Blocked'}
          </div>
        </div>
      </div>

      {!canScale && (
        <p className="text-xs text-sub">
          <span className="text-shape">⚠</span> Always-On demand shape is blocked until all four
          gates pass. A {'>'}3× volume increase without Gate 4 auto-throttles to the prior level.
        </p>
      )}

      <div className="space-y-2">
        {GATES.map((gate, idx) => {
          const passed = workload.governance[gate.key];
          const priorPassed = GATES.slice(0, idx).every((g) => workload.governance[g.key]);
          const locked = !passed && !priorPassed;
          return (
            <div
              key={gate.id}
              className={`rounded-card border px-4 py-3 transition-colors ${
                passed ? 'border-gate/50 bg-gate/5' : 'border-edge bg-slab'
              } ${locked ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-txt">{gate.title}</span>
                    <span className="font-mono text-[10px] text-dim">{gate.question}</span>
                  </div>
                  <p className="mt-1 text-xs text-sub">{gate.detail}</p>
                </div>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => toggleGate(workload.id, gate.id)}
                  className={`shrink-0 rounded-md border px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider transition-colors ${
                    passed
                      ? 'border-gate bg-gate/20 text-gate'
                      : 'border-edge text-sub hover:border-gate hover:text-gate'
                  } ${locked ? 'cursor-not-allowed' : ''}`}
                >
                  {passed ? 'Passed' : locked ? 'Locked' : 'Approve'}
                </button>
              </div>
              {passed && workload.governance.approved_by && gate.id === 'scale' && (
                <p className="mt-2 font-mono text-[10px] text-dim">
                  Approved by {workload.governance.approved_by}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

