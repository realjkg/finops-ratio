// Initiative Card (Ratio v2 Wave 2a). The executive projection of a Mission
// Card: headline monthly cost (cost token), a budget-consumed bar, a plain status
// badge, and cost efficiency (value ratio, R4 — never cost without value). On the
// executive surface each card carries a matrixed-lens callout: one line per role
// reading the same numbers differently.
import { formatRatio, formatUSD } from '@/lib/format';
import { EvidenceMark } from '@/components/EvidenceMark';
import type { LanguageMap } from '@/lib/languageMap';
import { INITIATIVE_STATUS_META, type InitiativeView } from './initiativeModel';

interface InitiativeCardProps {
  initiative: InitiativeView;
  lang: LanguageMap;
  // Matrixed-lens annotation is executive-surface only.
  showLens: boolean;
}

export function InitiativeCard({ initiative, lang, showLens }: InitiativeCardProps) {
  const meta = INITIATIVE_STATUS_META[initiative.status];

  return (
    <article
      className="flex flex-col gap-4 rounded-card border border-exec-border bg-exec-surface p-5 shadow-sm"
      style={{ borderLeft: `2px solid ${meta.color}` }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-exec-muted">
            {lang.itemLabel}
          </p>
          <h3 className="mt-0.5 truncate font-body text-base font-semibold text-exec-text">
            {initiative.name}
          </h3>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wide"
          style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
        >
          {meta.label}
        </span>
      </header>

      {/* Headline monthly cost — large, mono, cost token */}
      <div>
        <p className="font-mono text-3xl font-bold" style={{ color: TOKEN_COST }}>
          {formatUSD(initiative.monthlyCost)}
          <span className="ml-1 text-sm font-medium text-exec-muted">/mo</span>
        </p>
      </div>

      {/* Budget consumed bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-exec-muted">{lang.fuelLabel}</span>
          <span className="font-mono font-semibold text-exec-text">
            {initiative.budgetConsumedPct}%
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-exec-border"
          role="progressbar"
          aria-valuenow={initiative.budgetConsumedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${lang.fuelLabel}: ${initiative.budgetConsumedPct}%`}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${initiative.budgetConsumedPct}%`,
              backgroundColor: initiative.budgetConsumedColor,
            }}
          />
        </div>
      </div>

      {/* Cost efficiency (value ratio) — R4 pairing, with its provenance mark */}
      <p className="flex items-baseline gap-1.5 border-t border-exec-border pt-3 text-sm">
        <span className="text-exec-muted">{lang.valueRatioLabel}:</span>
        <span className="font-mono font-bold" style={{ color: initiative.valueColor }}>
          {formatRatio(initiative.valueRatio)}
        </span>
        <EvidenceMark status={initiative.valueEvidenceStatus} />
      </p>

      {showLens && <MatrixedLens initiative={initiative} />}
    </article>
  );
}

// Matrixed-lens callout: the same card, read by three matrixed-leadership roles.
// The line-manager reading only appears when a decision is actually pending.
function MatrixedLens({ initiative }: { initiative: InitiativeView }) {
  const rows: { role: string; reading: string }[] = [
    { role: 'CFO', reading: 'Monthly cost · savings opportunity' },
    { role: 'VP Platform', reading: 'Initiative status · budget variance' },
  ];
  if (initiative.status === 'pending_approval') {
    rows.push({ role: 'Line manager', reading: 'Pending Approval — action required' });
  }

  return (
    <dl className="space-y-1 rounded-card bg-exec-bg px-3 py-2.5 text-[11px] leading-snug">
      {rows.map((r) => (
        <div key={r.role} className="flex gap-1.5">
          <dt className="shrink-0 font-semibold text-exec-text">{r.role}:</dt>
          <dd className="text-exec-muted">{r.reading}</dd>
        </div>
      ))}
    </dl>
  );
}

const TOKEN_COST = '#ff5c72';

