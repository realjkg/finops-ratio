// Demand-shape badge — spec §3.3. Color-coded label per shape.

import type { DemandShape } from '@/types';
import { SHAPE_LABEL } from '@/lib/demandShape';
import { tint } from '@/lib/scales';

const SHAPE_COLOR: Record<DemandShape, string> = {
  always_on: 'var(--value)',
  business_hours: 'var(--unit)',
  throttled: 'var(--shape)',
  batch_offpeak: 'var(--gate)',
  paused: 'var(--dim)',
  unmanaged: 'var(--cost)',
};

export function DemandShapeBadge({ shape }: { shape: DemandShape }) {
  const color = SHAPE_COLOR[shape];
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider"
      style={{ color, background: tint(color) }}
    >
      {SHAPE_LABEL[shape]}
    </span>
  );
}

