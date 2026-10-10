// Total Cost of AI breakdown — audit C9, read-only slice (gate wall removed).
//
// Pairs the headline value ratio with the full-cost view the outcomes module
// uses inside the customer simulation. Outside a workspace there is no outcome
// record, so the value numerator and the three missing cost categories are
// estimated from workload data and marked by evidence status — the honest
// counterpart of the simulated panel, never a measured claim.
// Evidence, not a signature component: quiet rows, hairline borders, no motion.

import { EvidenceMark } from '@/components/EvidenceMark';
import { formatPct, formatRatio, formatUSD } from '@/lib/format';
import { ratioColor } from '@/lib/scales';
import { deriveDefensibleValue } from '@/lib/valueMath';
import { headlineEvidenceStatus, weakestStatus } from '@/lib/valueEvidence';
import { estimateTca } from './model';
import type { Workload } from '@/types';

export function TcaBreakdown({ workload }: { workload: Workload }) {
  const defensible = deriveDefensibleValue(
    workload.value,
    workload.costs.monthly_spend,
  );
  const tca = estimateTca(workload);
  const ev = workload.value.evidence;
  const claimedMark = weakestStatus([ev?.revenue_protected, ev?.cost_avoided]);
  const headlineMark = headlineEvidenceStatus(workload.value);

  return (
    <div
      data-testid="tca-breakdown"
      className="rounded-card border border-edge bg-slab px-4 py-3 text-xs"
    >
      {/* Numerator — the defensible value build (audit C3/C4). */}
      <p className="text-[10px] uppercase tracking-wider text-dim">
        Value numerator — defensible
      </p>
      <dl className="mt-2 space-y-1.5 font-mono">
        <Row
          label="Claimed value (revenue + cost avoided)"
          value={formatUSD(defensible.gross_value)}
          mark={claimedMark}
          detail="The seed's asserted business value, before any rigor gate"
        />
        <Row
          label="Quality floor pass rate"
          value={
            defensible.floor_applied
              ? formatPct(workload.value.quality_floor_pass_rate ?? 0)
              : 'not set — all outputs counted'
          }
          mark={ev?.quality_floor_pass_rate}
          detail="Outputs missing the workload's quality floor contribute no value"
        />
        <Row
          label="Harm from misses"
          value={`\u2212${formatUSD(defensible.harm_from_misses)}`}
          mark={ev?.harm_from_misses}
          detail="Monthly harm from missed outputs: refunds, rework, manual cleanup"
        />
        <Row
          label="Defensible numerator / mo"
          value={formatUSD(defensible.total_value)}
          mark={headlineMark}
          detail="Counted value minus harm — the headline ratio's numerator"
          strong
        />
      </dl>

      {/* Denominator — the full-cost pairing (audit C9). */}
      <p className="mt-4 text-[10px] uppercase tracking-wider text-dim">
        Total cost of AI — estimate
      </p>
      <dl className="mt-2 space-y-1.5 font-mono">
        {tca.lines.map((line) => (
          <Row
            key={line.category}
            label={line.label}
            value={formatUSD(line.cents / 100)}
            mark={line.status}
            detail={
              line.inHeadlineSpend
                ? `${line.basis} · inside the headline denominator`
                : line.basis
            }
          />
        ))}
        <Row
          label="Total cost of AI / mo"
          value={formatUSD(tca.fullCostCents / 100)}
          detail="Headline spend plus the estimated categories above"
          strong
        />
      </dl>

      <p className="mt-3 border-t border-edge pt-2.5 text-[11px] leading-relaxed text-sub">
        The headline denominator covers model usage and infrastructure only —
        implementation, oversight, and labor sit outside it. Return vs full
        cost:{' '}
        {tca.fullCostRatio === null ? (
          'not established'
        ) : tca.fullCostRatio > 0 ? (
          <span className="font-mono" style={{ color: ratioColor(tca.fullCostRatio) }}>
            {formatRatio(tca.fullCostRatio)}
          </span>
        ) : (
          <span className="font-mono text-cost">no positive return</span>
        )}
        . Estimates are marked, never measured — record actuals in your
        customer workspace.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  detail,
  mark,
  strong = false,
}: {
  label: string;
  value: string;
  detail: string;
  mark?: Parameters<typeof EvidenceMark>[0]['status'];
  strong?: boolean;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-3"
      title={detail}
    >
      <dt className={`min-w-0 ${strong ? 'text-txt' : 'text-sub'}`}>{label}</dt>
      <dd className="flex shrink-0 items-baseline gap-1.5">
        <span
          className={`text-[11px] ${strong ? 'font-bold text-txt' : 'text-txt'}`}
        >
          {value}
        </span>
        <EvidenceMark status={mark} />
      </dd>
    </div>
  );
}
