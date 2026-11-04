// Governance model for the Frameworks object — gate definitions and per-workload
// status derivation. Gate checks are verbatim from .obvious/obvious.md § Governance Gates.
// This is a pure-function module; no store imports, no side effects.

import type { GovernanceGateId, Workload, WorkloadGovernance } from '@/types';

export interface GateDef {
  id: GovernanceGateId;
  gateNumber: 1 | 2 | 3 | 4;
  label: string;
  /** Checks verbatim from .obvious/obvious.md Governance Gates. */
  checks: string[];
  /** Which boolean field on WorkloadGovernance tracks this gate. */
  govKey: keyof WorkloadGovernance;
}

export const GATE_DEFS: GateDef[] = [
  {
    id: 'policy',
    gateNumber: 1,
    label: 'Policy',
    checks: [
      'Model on the approved list',
      'Deployment region allowed',
      'Resource limits within policy',
    ],
    govKey: 'policy_check',
  },
  {
    id: 'ethics',
    gateNumber: 2,
    label: 'Ethics',
    checks: [
      'Bias audit complete',
      'PII handling documented',
      'Output safety review passed',
    ],
    govKey: 'ethics_review',
  },
  {
    id: 'cost',
    gateNumber: 3,
    label: 'Cost',
    checks: [
      'Monthly budget set',
      'Value / cost at or above the 3× target',
      'ROI projection documented',
    ],
    govKey: 'cost_approval',
  },
  {
    id: 'scale',
    gateNumber: 4,
    label: 'Scale',
    checks: [
      'All prior gates passed',
      'Scale authorization granted by PO / approver',
      'Demand shape ≠ unmanaged',
    ],
    govKey: 'scale_authorized',
  },
];

export interface WorkloadGateStatus {
  /** Number of gates that have passed (0–4). */
  gatesPassed: number;
  allPassed: boolean;
  /** The first gate NOT yet passed, or null if all four pass. */
  blockingGate: GateDef | null;
  /**
   * True when demand_shape is always_on but not all 4 gates pass.
   * always_on is blocked by enforcement rule until all gates authorize it.
   */
  alwaysOnConflict: boolean;
}

/**
 * Derive the gate status for a single workload.
 * Gates are sequential — we stop counting at the first failure.
 */
export function deriveGateStatus(workload: Workload): WorkloadGateStatus {
  let gatesPassed = 0;
  let blockingGate: GateDef | null = null;

  for (const gate of GATE_DEFS) {
    if (workload.governance[gate.govKey]) {
      gatesPassed++;
    } else {
      blockingGate = gate;
      break; // gates are sequential; later gates can't pass without this one
    }
  }

  const allPassed = gatesPassed === 4;
  const alwaysOnConflict = !allPassed && workload.demand_shape === 'always_on';

  return { gatesPassed, allPassed, blockingGate, alwaysOnConflict };
}

