// FindingsPage — Wave 4 home screen (Slice 3: Apply → change-management audit trail).
// Ranked findings queue (worst value-ratio first) on the left;
// recommendation pane for the selected finding on the right.
//
// Two ITSM paths (R3: governance precedes scale):
//   NORMAL change:         Apply → createChange → finding enters pending_cm + audit chip.
//   STANDARD/pre-approved: enter existing ref → attachReference → immediate applied.
//
// Captured tally counts only governed changes (findings with a CM audit record).
// Verbs stay exactly: Select / Apply / Dismiss. Warm accent (‘shape’) on Apply CTA only.
// No badges, confetti, streaks — quiet governance. Calm register throughout.

import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildFindings, type FindingView } from './findingsModel';
import { ValueRatioMeter } from './ValueRatioMeter';
import { SpendToValueGraph } from './SpendToValueGraph';
import { formatUSD, formatRatio } from '@/lib/format';
import { TOKEN_HEX } from '@/lib/scales';
import {
  createCMClient,
  type CMProvider,
  type CMReferenceRecord,
  type FindingStatus,
} from '@/cm';
import type { Workload } from '@/types';

// ---------------------------------------------------------------------------
// Governance state (UI-layer types, backed by the CMClient seam)
// ---------------------------------------------------------------------------

interface FindingGovernanceState {
  status: FindingStatus;
  /** Set once a CM ticket or reference has been recorded. Counts toward captured tally. */
  auditRecord?: CMReferenceRecord;
}

// NEXT_PUBLIC_CM_MODE is a build-time constant in Next.js; mock is the offline-safe default.
const cmModeEnv = process.env.NEXT_PUBLIC_CM_MODE;

export function FindingsPage() {
  const workloads = useStore((s) => s.workloads);
  const findings = useMemo(() => buildFindings(workloads), [workloads]);

  // Auto-select the worst finding on first render.
  const [selectedId, setSelectedId] = useState<string | null>(
    () => findings[0]?.workloadId ?? null,
  );
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set());

  // Governance state per finding, keyed by workloadId.
  const [governanceMap, setGovernanceMap] = useState<
    ReadonlyMap<string, FindingGovernanceState>
  >(new Map());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<{
    workloadId: string;
    message: string;
  } | null>(null);

  // Stable CM client — MockCMClient by default, LiveCMClient when NEXT_PUBLIC_CM_MODE=live.
  const cmClient = useMemo(
    () => createCMClient(cmModeEnv === 'live' ? 'live' : 'mock'),
    [],
  );

  // Captured tally: only findings with a CM audit record count (governed changes only).
  const capturedCount = useMemo(
    () => [...governanceMap.values()].filter((s) => s.auditRecord).length,
    [governanceMap],
  );

  const visible = findings.filter((f) => !dismissedIds.has(f.workloadId));
  const selected = visible.find((f) => f.workloadId === selectedId) ?? visible[0] ?? null;

  function handleSelect(id: string) {
    setSelectedId(id);
  }

  /** Normal ITSM path: creates a governed CM ticket; finding enters pending_cm. */
  async function handleApply(finding: FindingView) {
    setApplyingId(finding.workloadId);
    setApplyError(null);
    try {
      const result = await cmClient.createChange(
        {
          workloadId: finding.workloadId,
          workloadName: finding.workloadName,
          recommendedAction: finding.recommendedAction,
          // CM seam expects a number; "not quantified" findings forward 0.
          projectedMonthlyImpact: finding.projectedMonthlyImpact ?? 0,
        },
        finding.recommendedAction,
      );
      setGovernanceMap((prev) => {
        const next = new Map(prev);
        next.set(finding.workloadId, {
          status: 'pending_cm',
          auditRecord: {
            provider: result.provider,
            ticketRef: result.ticketRef,
            url: result.url,
            createdAt: result.createdAt,
          },
        });
        return next;
      });
    } catch (err) {
      // Never swallow — surface inline so the user can retry.
      setApplyError({
        workloadId: finding.workloadId,
        message: `Failed to create change ticket: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      setApplyingId(null);
    }
  }

  /** Pre-approved ITSM path: validates and attaches an existing ref; finding enters applied. */
  async function handleAttach(
    finding: FindingView,
    ticketRef: string,
    provider: CMProvider,
  ) {
    setApplyingId(finding.workloadId);
    setApplyError(null);
    try {
      const record = await cmClient.attachReference({ provider, ticketRef });
      setGovernanceMap((prev) => {
        const next = new Map(prev);
        next.set(finding.workloadId, {
          status: 'applied',
          auditRecord: {
            provider: record.provider,
            ticketRef: record.ticketRef,
            url: record.url,
            createdAt: record.createdAt,
          },
        });
        return next;
      });
    } catch (err) {
      setApplyError({
        workloadId: finding.workloadId,
        message: `Failed to attach reference: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      setApplyingId(null);
    }
  }

  function handleDismiss(id: string) {
    setDismissedIds((prev) => new Set([...prev, id]));
    // Advance selection to the next visible finding.
    const idx = visible.findIndex((f) => f.workloadId === id);
    const next = visible[idx + 1] ?? visible[idx - 1] ?? null;
    setSelectedId(next?.workloadId ?? null);
  }

  return (
    <div className="flex h-full flex-col bg-void font-body text-txt">
      {/* Page header */}
      <header className="shrink-0 border-b border-edge bg-deep px-6 py-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="font-mono text-lg font-bold text-txt">Findings</h1>
            <p className="mt-0.5 text-xs text-sub">
              Workloads ranked by value ratio — worst first. Below the 3× value minimum.
            </p>
          </div>
          {capturedCount > 0 && (
            <span className="font-mono text-xs text-dim">
              {capturedCount} governed action{capturedCount !== 1 ? 's' : ''} captured
            </span>
          )}
        </div>
      </header>

      {/* Two-pane content */}
      <div className="flex min-h-0 flex-1">
        {/* Left: ranked findings list */}
        <aside
          className="w-72 shrink-0 overflow-y-auto border-r border-edge lg:w-80"
          aria-label="Findings list"
        >
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <p className="font-mono text-sm text-dim">All findings dismissed</p>
            </div>
          ) : (
            visible.map((f, idx) => (
              <FindingRow
                key={f.workloadId}
                finding={f}
                rank={idx + 1}
                isSelected={f.workloadId === selected?.workloadId}
                governanceState={governanceMap.get(f.workloadId)}
                onSelect={() => handleSelect(f.workloadId)}
              />
            ))
          )}
        </aside>

        {/* Right: recommendation pane */}
        <main className="flex-1 overflow-y-auto" aria-label="Recommendation">
          {selected ? (
            // key resets local pane state (ref form inputs) when the finding changes.
            <RecommendationPane
              key={selected.workloadId}
              finding={selected}
              allWorkloads={workloads}
              governance={governanceMap.get(selected.workloadId)}
              isApplying={applyingId === selected.workloadId}
              applyError={
                applyError?.workloadId === selected.workloadId
                  ? applyError.message
                  : null
              }
              onApply={() => {
                void handleApply(selected);
              }}
              onAttach={(ticketRef, provider) => {
                void handleAttach(selected, ticketRef, provider);
              }}
              onDismiss={() => handleDismiss(selected.workloadId)}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="font-mono text-sm text-dim">
                Select a finding to view the recommendation
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FindingRow — compact list item
// ---------------------------------------------------------------------------

function FindingRow({
  finding,
  rank,
  isSelected,
  governanceState,
  onSelect,
}: {
  finding: FindingView;
  rank: number;
  isSelected: boolean;
  governanceState: FindingGovernanceState | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-edge px-4 py-3 text-left transition-colors ${
        isSelected ? 'bg-raised' : 'hover:bg-raised/40'
      }`}
      aria-pressed={isSelected}
      aria-label={`Finding ${rank}: ${finding.workloadName}`}
    >
      <div className="flex items-start gap-2.5">
        {/* Rank */}
        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-dim w-4 text-right">
          {rank}
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-body text-sm font-medium text-txt">
              {finding.workloadName}
            </span>
            {/* Evidence: ratio + spend */}
            <div className="flex shrink-0 items-center gap-2">
              <span
                className="font-mono text-xs font-bold"
                style={{ color: finding.valueColor }}
              >
                {formatRatio(finding.valueRatio)}
              </span>
              <span className="font-mono text-[11px] text-dim">
                {formatUSD(finding.monthlySpend, { compact: true })}/mo
              </span>
            </div>
          </div>

          {/* Inline meter — quiet */}
          <ValueRatioMeter ratio={finding.valueRatio} size="inline" />

          {/* Governance indicator — subtle; only when a CM record is attached */}
          {governanceState?.auditRecord && (
            <p
              className="font-mono text-[9px] uppercase tracking-wider"
              style={{
                color:
                  governanceState.status === 'applied'
                    ? TOKEN_HEX.value
                    : TOKEN_HEX.gate,
              }}
            >
              {governanceState.status === 'applied' ? 'applied' : 'governed'}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// RecommendationPane — enlarged detail for the selected finding
// ---------------------------------------------------------------------------

function RecommendationPane({
  finding,
  allWorkloads,
  governance,
  isApplying,
  applyError,
  onApply,
  onAttach,
  onDismiss,
}: {
  finding: FindingView;
  allWorkloads: Workload[];
  governance: FindingGovernanceState | undefined;
  isApplying: boolean;
  applyError: string | null;
  onApply: () => void;
  onAttach: (ticketRef: string, provider: CMProvider) => void;
  onDismiss: () => void;
}) {
  // Pre-approved ref form local state — reset automatically via key={finding.workloadId}.
  const [showRefForm, setShowRefForm] = useState(false);
  const [refInput, setRefInput] = useState('');
  const [refProvider, setRefProvider] = useState<CMProvider>('jira');

  const hasAuditRecord = !!governance?.auditRecord;

  function handleAttachSubmit() {
    const ref = refInput.trim();
    if (!ref) return;
    onAttach(ref, refProvider);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 px-8 py-8">
      {/* Workload name */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-dim">Finding</p>
        <h2 className="mt-1 font-body text-xl font-semibold text-txt">
          {finding.workloadName}
        </h2>
        <p className="mt-1 text-sm text-sub">{finding.problem}</p>
      </div>

      {/* Value-ratio meter — enlarged */}
      <ValueRatioMeter ratio={finding.valueRatio} size="large" />

      {/* Evidence: two values */}
      <section aria-label="Evidence">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-dim">Evidence</p>
        <div className="grid grid-cols-2 gap-3">
          <EvidenceCell
            label="Current ratio"
            value={formatRatio(finding.valueRatio)}
            color={finding.valueColor}
            bold
          />
          <EvidenceCell
            label="Monthly spend"
            value={formatUSD(finding.monthlySpend)}
            color={TOKEN_HEX.cost}
          />
        </div>
        {/* Spend-to-value graph — portfolio context */}
        <div className="mt-4 rounded-md border border-edge bg-slab p-3">
          <p className="mb-3 font-mono text-[9px] uppercase tracking-wider text-dim">
            Portfolio context — spend vs. value
          </p>
          <SpendToValueGraph
            workloads={allWorkloads}
            selectedWorkloadId={finding.workloadId}
            size="large"
          />
        </div>
      </section>

      {/* Recommended action */}
      <section aria-label="Recommended action">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-dim">
          Recommended action
        </p>
        <p className="text-sm text-txt">{finding.recommendedAction}</p>
      </section>

      {/* Projected impact — hero figure + honest qualification (Slice 5) */}
      <section aria-label="Projected monthly impact">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-dim">
          Projected monthly impact
        </p>
        {finding.projectedMonthlyImpact !== null &&
        finding.projectedMonthlyImpact > 0 ? (
          <>
            <div className="flex items-baseline gap-2">
              {/* Bold hero per the visual register — value green. */}
              <span
                className="font-mono text-3xl font-bold"
                style={{ color: TOKEN_HEX.value }}
              >
                {formatUSD(finding.projectedMonthlyImpact)}
              </span>
              <span className="font-mono text-xs text-dim">/mo lower spend</span>
              {finding.projectedRatio !== null && (
                <span className="font-mono text-xs text-sub">
                  → {formatRatio(finding.projectedRatio)} ratio
                </span>
              )}
            </div>
          </>
        ) : (
          // Honest: impact that cannot be computed is never fabricated.
          <span className="font-mono text-lg text-dim">Not quantified</span>
        )}

        {/* Basis — what the figure is computed from (quiet). */}
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-dim">
          <span className="uppercase tracking-wider">Basis </span>
          {finding.impactBasis}
        </p>
        {/* Confidence / assumption note — never presents a projection as a saving. */}
        <p className="mt-1 font-body text-xs leading-relaxed text-sub">
          {finding.confidenceNote}
        </p>
      </section>

      {/* Change-management / governance verbs */}
      <section aria-label="Change management">
        {hasAuditRecord && governance?.auditRecord ? (
          /* Audit chip — rendered once a CM record is attached to this finding */
          <div className="space-y-3">
            <AuditChip record={governance.auditRecord} status={governance.status} />
            {/* Dismiss remains available after governance */}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border border-edge px-4 py-2 font-mono text-sm text-sub transition-colors hover:border-sub hover:text-txt focus:outline-none focus-visible:ring-2 focus-visible:ring-edge"
            >
              Dismiss
            </button>
          </div>
        ) : (
          /* Verb area — Apply (normal change) + optional pre-approved path */
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {/* Apply — warm accent, reserved for the recommended-action CTA only. */}
              <button
                type="button"
                onClick={onApply}
                disabled={isApplying}
                className="rounded-md px-4 py-2 font-mono text-sm font-bold transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-shape/60 disabled:opacity-50"
                style={{
                  background: TOKEN_HEX.shape,
                  color: '#05070b', // void — high contrast on amber
                }}
              >
                {isApplying && !showRefForm ? 'Creating ticket…' : 'Apply'}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={isApplying}
                className="rounded-md border border-edge px-4 py-2 font-mono text-sm text-sub transition-colors hover:border-sub hover:text-txt focus:outline-none focus-visible:ring-2 focus-visible:ring-edge disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>

            {/* Pre-approved reference path */}
            <div>
              <button
                type="button"
                onClick={() => setShowRefForm((v) => !v)}
                className="font-mono text-[11px] text-dim underline underline-offset-2 transition-colors hover:text-sub focus:outline-none"
              >
                {showRefForm
                  ? 'Cancel pre-approved ref'
                  : 'Have a pre-approved reference?'}
              </button>

              {showRefForm && (
                <div className="mt-3 space-y-2 rounded-md border border-edge bg-slab p-3">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-dim">
                    Attach pre-approved reference
                  </p>
                  <div className="flex items-center gap-2">
                    {/* Provider selector */}
                    <select
                      value={refProvider}
                      onChange={(e) => setRefProvider(e.target.value as CMProvider)}
                      disabled={isApplying}
                      className="rounded border border-edge bg-deep font-mono text-xs text-sub px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-edge disabled:opacity-50"
                      aria-label="ITSM provider"
                    >
                      <option value="jira">Jira</option>
                      <option value="servicenow">ServiceNow</option>
                      <option value="mock">Mock</option>
                    </select>
                    {/* Ref input */}
                    <input
                      type="text"
                      value={refInput}
                      onChange={(e) => setRefInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAttachSubmit();
                      }}
                      placeholder="e.g. CHG-1234 or OPS-567"
                      disabled={isApplying}
                      className="flex-1 rounded border border-edge bg-deep font-mono text-xs text-txt placeholder:text-dim px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-edge disabled:opacity-50"
                      aria-label="Ticket or incident reference"
                    />
                    <button
                      type="button"
                      onClick={handleAttachSubmit}
                      disabled={isApplying || !refInput.trim()}
                      className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-sub transition-colors hover:border-sub hover:text-txt focus:outline-none focus-visible:ring-1 focus-visible:ring-edge disabled:opacity-40"
                    >
                      {isApplying && showRefForm ? 'Attaching…' : 'Attach'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Inline error — never swallowed */}
            {applyError && (
              <p
                className="font-mono text-xs"
                style={{ color: TOKEN_HEX.cost }}
                role="alert"
              >
                {applyError}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditChip — governance audit record; rendered wherever a finding is governed
// ---------------------------------------------------------------------------

function AuditChip({
  record,
  status,
}: {
  record: CMReferenceRecord;
  status: FindingStatus;
}) {
  const isApplied = status === 'applied';
  const accentColor = isApplied ? TOKEN_HEX.value : TOKEN_HEX.gate;
  const statusLabel = isApplied
    ? 'Applied — reference attached'
    : 'Governed — change ticket created';
  const providerLabel =
    record.provider === 'servicenow' ? 'ServiceNow' : record.provider.toUpperCase();
  const dateStr = new Date(record.createdAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <div
      className="rounded-md border p-3 space-y-1.5"
      style={{ borderColor: accentColor + '40' }}
    >
      <p
        className="font-mono text-[10px] uppercase tracking-wider font-bold"
        style={{ color: accentColor }}
      >
        {statusLabel}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-sub">{providerLabel}</span>
        <span className="text-dim">·</span>
        <span className="font-mono text-xs font-bold text-txt">{record.ticketRef}</span>
        <span className="text-dim">·</span>
        <span className="font-mono text-[11px] text-dim">{dateStr}</span>
        {record.url && (
          <>
            <span className="text-dim">·</span>
            <a
              href={record.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs underline underline-offset-2 transition-opacity hover:opacity-80"
              style={{ color: accentColor }}
              aria-label={`Open ${record.ticketRef} in ${providerLabel}`}
            >
              ↗
            </a>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EvidenceCell — compact data chip used in the evidence grid
// ---------------------------------------------------------------------------

function EvidenceCell({
  label,
  value,
  color,
  bold = false,
}: {
  label: string;
  value: string;
  color: string;
  bold?: boolean;
}) {
  return (
    <div className="rounded-md border border-edge bg-slab p-3">
      <p className="font-mono text-[10px] text-dim">{label}</p>
      <p
        className={`mt-1 font-mono text-base ${bold ? 'font-bold' : ''}`}
        style={{ color }}
      >
        {value}
      </p>
    </div>
  );
}
