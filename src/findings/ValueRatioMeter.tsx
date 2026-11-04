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
import { ratioDomain, ratioFraction, ratioTickLabel, RATIO_CEILING, type RatioDomain } from './ratioAxis';

interface ValueRatioMeterProps {
  /** Unrounded Value / cost; null (or non-finite) means N/A: no fill, no value. */
  ratio: number | null;
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
  const na = ratio === null || !Number.isFinite(ratio);
  const color = na ? 'var(--dim)' : ratioColor(ratio as number);
  const domain = domainProp ?? ratioDomain([ratio]);
  const pct = (v: number) => ratioFraction(v, domain) * 100;
  const zeroPct = pct(0);
  const valuePct = na ? zeroPct : pct(ratio as number);
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
            aria-label={na ? `${VOCAB.valueToCost.label} not available` : `${formatRatio(ratio)} ${VOCAB.valueToCost.label}`}
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
          aria-valuenow={na ? undefined : Math.min(Math.max(ratio as number, domain.min), RATIO_CEILING)}
          aria-valuetext={formatRatio(ratio)}
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
          {/* One label for the origin. The negative floor gets no label of its own: it sat
              on top of 0× at narrow widths and large text, and the 0× line already marks where
              the bar starts. */}
          <span className={hasNegativeAxis ? 'absolute -translate-x-1/2' : 'absolute left-0'} style={hasNegativeAxis ? { left: `${zeroPct}%` } : undefined}>
            0×
          </span>
          <span
            className="absolute top-3.5 text-sub" /* own row: 0× and 1× collided in narrow lists */
            style={{ left: `${breakEvenPct}%` }}
          >
            1× break-even
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: `${targetPct}%` }}>
            {VALUE_MINIMUM}× target
          </span>
          {domain.clipped && (
            <span className="absolute left-0 top-3.5 text-dim" data-testid="meter-clip">{ratioTickLabel(domain.min, domain)}</span>
          )}
          <span className="absolute right-0">{RATIO_CEILING}×</span>
        </div>
      )}
    </div>
  );
}
