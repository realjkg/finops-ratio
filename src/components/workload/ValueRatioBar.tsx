// Horizontal value-ratio bar — spec §3.3. Colored by the §10.3 ratio scale,
// width scaled against a reference ceiling so excellent ratios visibly fill it.

import { formatReturn } from '@/lib/format';
import { ratioColor } from '@/lib/scales';

const REFERENCE_CEILING = 25; // ratios at/above this fill the bar

export function ValueRatioBar({
  ratio,
  rightLabel,
}: {
  ratio: number;
  rightLabel: string;
}) {
  const color = ratioColor(ratio);
  const pct = Math.max(Math.min(ratio / REFERENCE_CEILING, 1), 0.04) * 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs font-bold" style={{ color }}>
          {formatReturn(ratio)}
        </span>
        <span className="font-mono text-[11px] text-sub">{rightLabel}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-void">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

