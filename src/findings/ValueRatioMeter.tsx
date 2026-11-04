// ValueRatioMeter — one bar that shows Value / cost against two reference marks:
//   1× break-even — value equals cost.
//   3× target     — the configured policy target (VALUE_MINIMUM, Gate 3), not a financial standard.
// Value / cost is (counted value − harm from misses) ÷ monthly cost, so it can be negative.
// The axis therefore starts below zero when any ratio in view is negative (see ratioAxis.ts),
// and the fill is drawn from the 0× line toward the value: left for a negative, right for a gain.
// Colors from the existing ratio color scale; no new tokens.
// Two sizes:
//   'inline' — quiet (h-1.5), used inside each finding row.
//   'large'  — enlarged (h-2.5 with ratio label + axis), used in the recommendation pane.

import { ratioColor } from '@/lib/scales';
import { formatRatio } from '@/lib/format';
import { EvidenceMark } from '@/components/EvidenceMark';
import { VOCAB, VALUE_COST_BREAK_EVEN } from '@/lib/vocabulary';
import type { EvidenceStatus } from '@/types';
import { VALUE_MINIMUM } from './findingsModel';
import { ratioDomain, ratioFraction, RATIO_CEILING, type RatioDomain } from './ratioAxis';

interface ValueRatioMeterProps {
  ratio: number;
  size?: 'inline' | 'large';
  /** Provenance mark rendered beside the enlarged ratio (large size only). */
  evidenceStatus?: EvidenceStatus;
  /**
   * Shared axis for every meter on the page, so rows stay comparable. Defaults to the
   * domain that fits this one ratio.
   */
  domain?: RatioDomain;
  /** Hide the large headline number when the caller already shows it (the finding card does). */
  hideHeadline?: boolean;
}

export function ValueRatioMeter({
  ratio,
  size = 'inline',
  evidenceStatus,
  domain: domainProp,
  hideHeadline = false,
}: ValueRatioMeterProps) {
  const color = ratioColor(ratio);
  const domain = domainProp ?? ratioDomain([ratio]);
  const pct = (v: number) => ratioFraction(v, domain) * 100;
  const zeroPct = pct(0);
  const valuePct = pct(ratio);
  // Fill runs between the 0× line and the value: left of zero when negative.
  const fillLeft = Math.min(zeroPct, valuePct);
  const fillWidth = Math.abs(valuePct - zeroPct);
  const breakEvenPct = pct(VALUE_COST_BREAK_EVEN);
  const targetPct = pct(VALUE_MINIMUM);
  const isLarge = size === 'large';
  const hasNegativeAxis = domain.min < 0;

  return (
    <div className={`w-full${isLarge ? ' space-y-1.5' : ''}`}>
      {isLarge && !hideHeadline && (
        <div className="flex items-baseline gap-2.5">
          <span
            className="font-mono text-2xl font-bold"
            style={{ color }}
            aria-label={`${ratio.toFixed(1)} times ${VOCAB.valueToCost.label}`}
          >
            {formatRatio(ratio)}
          </span>
          <EvidenceMark status={evidenceStatus} className="self-center" />
        </div>
      )}

      {/* Track — markers are siblings positioned over it */}
      <div className="relative w-full">
        <div
          role="meter"
          aria-valuenow={ratio}
          aria-valuemin={domain.min}
          aria-valuemax={RATIO_CEILING}
          aria-label={`${VOCAB.valueToCost.label}: ${formatRatio(ratio)}`}
          className={`relative w-full overflow-hidden rounded-full bg-raised ${
            isLarge ? 'h-2.5' : 'h-1.5'
          }`}
        >
          <div
            className="absolute top-0 h-full motion-safe:transition-all motion-safe:duration-300"
            style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: color }}
          />
        </div>

        {/* 0× line — only drawn when the axis extends below zero */}
        {hasNegativeAxis && (
          <div
            className={`pointer-events-none absolute top-0 ${
              isLarge ? 'h-2.5 w-0.5' : 'h-1.5 w-px'
            } bg-txt/60`}
            style={{ left: `${zeroPct}%` }}
            aria-hidden="true"
          />
        )}

        {/* 1× break-even mark */}
        <div
          className={`pointer-events-none absolute top-0 ${
            isLarge ? 'h-2.5 w-0.5' : 'h-1.5 w-px'
          } bg-sub/50`}
          style={{ left: `${breakEvenPct}%` }}
          aria-hidden="true"
        />

        {/* 3× target mark */}
        <div
          className={`pointer-events-none absolute top-0 ${
            isLarge ? 'h-2.5 w-0.5' : 'h-1.5 w-px'
          } bg-dim/70`}
          style={{ left: `${targetPct}%` }}
          aria-hidden="true"
        />
      </div>

      {/* Axis labels — large variant only. Two rows so neighbouring labels never collide. */}
      {isLarge && (
        <div className="relative h-7 text-[11px] text-dim">
          <span className="absolute left-0">{domain.min}×</span>
          {hasNegativeAxis && (
            <span className="absolute -translate-x-1/2" style={{ left: `${zeroPct}%` }}>
              0×
            </span>
          )}
          <span
            className="absolute top-3.5 text-sub" /* own row: 0× and 1× collided in narrow lists */
            style={{ left: `${breakEvenPct}%` }}
          >
            1× break-even
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: `${targetPct}%` }}>
            {VALUE_MINIMUM}× target
          </span>
          <span className="absolute right-0">{RATIO_CEILING}×</span>
        </div>
      )}
    </div>
  );
}
