// ValueRatioMeter — Wave 4 Slice 1 signature component.
// A single bar that shows the value ratio against two reference marks:
//   1.0× value line — the break-even point (spending = value returned).
//   3.0× minimum line — the Gate 3 configured minimum (VALUE_MINIMUM).
// Colors from the existing ratio color scale; no new tokens.
// Two sizes:
//   'inline' — quiet (h-1.5), used inside each finding row.
//   'large'  — enlarged (h-2.5 with ratio label + axis), used in the recommendation pane.

import { ratioColor } from '@/lib/scales';
import { formatRatio } from '@/lib/format';
import { EvidenceMark } from '@/components/EvidenceMark';
import type { EvidenceStatus } from '@/types';
import { VALUE_MINIMUM } from './findingsModel';

// Scale ceiling: ratios at or above this fill the bar completely.
const CEILING = 10;
const VALUE_LINE_PCT = (1.0 / CEILING) * 100;    // 10% — break-even
const MIN_LINE_PCT = (VALUE_MINIMUM / CEILING) * 100; // 30% — Gate 3 floor

interface ValueRatioMeterProps {
  ratio: number;
  size?: 'inline' | 'large';
  /** Provenance mark rendered beside the enlarged ratio (large size only). */
  evidenceStatus?: EvidenceStatus;
}

export function ValueRatioMeter({
  ratio,
  size = 'inline',
  evidenceStatus,
}: ValueRatioMeterProps) {
  const color = ratioColor(ratio);
  const fillPct = Math.max(0, Math.min(ratio / CEILING, 1)) * 100;
  const isLarge = size === 'large';

  return (
    <div className={`w-full${isLarge ? ' space-y-1.5' : ''}`}>
      {isLarge && (
        <div className="flex items-baseline gap-2.5">
          <span
            className="font-mono text-2xl font-bold"
            style={{ color }}
            aria-label={`${ratio.toFixed(1)} times value ratio`}
          >
            {formatRatio(ratio)}
          </span>
          <EvidenceMark status={evidenceStatus} className="self-center" />
          {ratio < VALUE_MINIMUM && (
            <span className="font-mono text-sm text-cost">
              {formatRatio(VALUE_MINIMUM - ratio)} below minimum
            </span>
          )}
        </div>
      )}

      {/* Track — markers are siblings positioned over it */}
      <div className="relative w-full">
        <div
          role="meter"
          aria-valuenow={ratio}
          aria-valuemin={0}
          aria-valuemax={CEILING}
          aria-label={`Value ratio: ${formatRatio(ratio)}`}
          className={`w-full overflow-hidden rounded-full bg-raised ${
            isLarge ? 'h-2.5' : 'h-1.5'
          }`}
        >
          <div
            className="h-full rounded-full motion-safe:transition-all motion-safe:duration-300"
            style={{ width: `${fillPct}%`, background: color }}
          />
        </div>

        {/* 1× value line — break-even mark */}
        <div
          className={`pointer-events-none absolute top-0 ${
            isLarge ? 'h-2.5 w-0.5' : 'h-1.5 w-px'
          } bg-sub/50`}
          style={{ left: `${VALUE_LINE_PCT}%` }}
          aria-hidden="true"
        />

        {/* 3× minimum line — Gate 3 threshold mark */}
        <div
          className={`pointer-events-none absolute top-0 ${
            isLarge ? 'h-2.5 w-0.5' : 'h-1.5 w-px'
          } bg-dim/70`}
          style={{ left: `${MIN_LINE_PCT}%` }}
          aria-hidden="true"
        />
      </div>

      {/* Axis labels — large variant only */}
      {isLarge && (
        <div className="relative h-3.5">
          <span className="absolute left-0 font-mono text-[9px] text-dim">0×</span>
          <span
            className="absolute -translate-x-1/2 font-mono text-[9px] text-sub"
            style={{ left: `${VALUE_LINE_PCT}%` }}
          >
            1× value
          </span>
          <span
            className="absolute -translate-x-1/2 font-mono text-[9px] text-dim"
            style={{ left: `${MIN_LINE_PCT}%` }}
          >
            3× min
          </span>
          <span className="absolute right-0 font-mono text-[9px] text-dim">{CEILING}×</span>
        </div>
      )}
    </div>
  );
}

