import Link from "next/link";
import { useState, type ReactNode, type FormEvent } from "react";
import { useStore } from "@/store/useStore";
import { formatUSD, formatRatio } from "@/lib/format";
import { evaluateOutcome, monetaryBenefit, outcomeBasis } from "./model";
import {
  COST_CATEGORIES,
  type OutcomeRecord,
  type ValueMeasure,
  type AdditionalCostCategory,
  type AdditionalCost,
  type OutcomeAction,
} from "./types";

const COST_LABELS = {
  infrastructure: "Infrastructure",
  implementation: "Implementation allocation",
  oversight: "Oversight",
  labor: "Ongoing labor",
};
const CATEGORY_LABELS = {
  revenue: "Revenue contribution",
  cost_savings: "Realized cost savings",
  quality: "Quality improvement",
  risk: "Reduced risk",
};
export function OutcomesPanel({ workloadId }: { workloadId: string }) {
  const sim = useStore((s) => s.simulation);
  const busy = useStore((s) => s.simulationBusy);
  const error = useStore((s) => s.simulationError);
  const run = useStore((s) => s.simulationCommand);
  const [edit, setEdit] = useState<string | null>(null);
  if (!sim)
    return (
      <div className="rounded border border-edge p-5">
        <h2 className="text-lg">Outcome accountability</h2>
        <p className="mt-3 text-sub">
          Save an owner, baseline, evidence, full cost and decision thresholds
          in your customer workspace.
        </p>
        <Link
          className="mt-4 inline-block text-unit underline"
          href="/simulation"
        >
          Sign in to the customer simulation
        </Link>
      </div>
    );
  const record = sim.state.outcomes[workloadId];
  if (!record) return <p>Choose an initiative to measure.</p>;
  const result = evaluateOutcome(record, sim.state.ledger);
  const reviewer = sim.session.identity.persona !== "technical";
  const latest = record.decisions.at(-1);
  const stale =
    latest &&
    latest.basis !==
      outcomeBasis(
        record,
        sim.state.ledger,
        sim.state.workloads.find((w) => w.id === workloadId)!.governance,
      );
  const canExpand = (() => {
    const g = sim.state.workloads.find((w) => w.id === workloadId)!.governance;
    return (
      g.policy_check && g.ethics_review && g.cost_approval && g.scale_authorized
    );
  })();
  return (
    <div className="space-y-6" data-testid="outcome-accountability">
      <header>
        <h2 className="text-xl font-semibold">Outcome accountability</h2>
        <p className="mt-2 text-sm text-sub">
          {record.owner} · {record.ownerRole}. Observation:{" "}
          {record.observation.start}–{record.observation.end}. All sample data
          is simulated.
        </p>
        <p className="mt-2 text-xs text-sub">
          Evidence status describes the claim’s maturity within this simulation.
          Verified sample claims are not real customer returns.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-cost">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label={
            result.costsMeasured
              ? "Recorded full cost · reporting period"
              : "Estimated full cost · reporting period"
          }
          value={
            result.totalCostCents === null
              ? "Incomplete"
              : formatUSD(result.totalCostCents / 100)
          }
          detail={`${formatUSD(result.estimatedCostCents / 100)} in known amounts · outcome target ${record.target} ${record.unit}`}
        />
        <Metric
          label="Reviewed measured benefit"
          value={formatUSD(result.measuredBenefitCents / 100)}
          detail="Attributed contribution and realized spending reductions"
        />
        <Metric
          label="Measured benefit / full cost"
          value={
            result.measuredRatio === null
              ? "Not established"
              : formatRatio(result.measuredRatio)
          }
          detail={
            result.netRoiPct === null
              ? "Complete cost and evidence review to establish a return"
              : `Net ROI ${result.netRoiPct.toFixed(1)}%`
          }
        />
      </div>
      <Section title="Owner and pre-AI baseline">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-edge p-3 text-sm">
          <p className="text-sub">
            {record.planVerified
              ? `Performance evidence verified by ${record.planVerified.by}`
              : record.planRecordedBy
                ? `Awaiting independent review · recorded by ${record.planRecordedBy}`
                : "Legacy baseline · re-save to establish its recorder"}
          </p>
          {!record.planVerified && (
            <button
              type="button"
              className="sim-button"
              disabled={
                busy ||
                !reviewer ||
                !record.planRecordedBy ||
                record.planRecordedBy === sim.session.identity.user
              }
              onClick={() =>
                void run({ type: "verify-outcome-plan", workloadId })
              }
            >
              Verify baseline evidence
            </button>
          )}
        </div>
        <PlanForm
          key={JSON.stringify([
            record.owner,
            record.ownerRole,
            record.metric,
            record.unit,
            record.baseline,
            record.observation,
            record.target,
            record.thresholds,
            record.direction,
          ])}
          record={record}
          busy={busy}
          save={(plan) =>
            void run({ type: "save-outcome-plan", workloadId, plan })
          }
        />
        <p className="mt-4 text-sm text-sub">
          Performance: {record.baseline.value} → {record.observation.value}{" "}
          {record.unit}.{" "}
          {result.improvementPct === null
            ? "Relative change is undefined for a zero baseline."
            : `${result.improvementPct.toFixed(1)}% ${result.improvement >= 0 ? "improvement" : "deterioration"}.`}{" "}
          Target {result.targetMet ? "met" : "not met"}.
        </p>
        {!result.equalDuration && (
          <p className="mt-2 text-sm text-shape">
            Compare equal-duration periods before making a return-based
            decision.
          </p>
        )}
      </Section>
      <Section title="Value measures and evidence">
        <p className="text-sm text-sub">
          Revenue uses contribution margin before the AI costs recorded here, plus attribution. Savings require an
          actual reduction in spending. Quality and risk evidence support the
          performance goal; they do not automatically become cash value.
          Overlapping claims must be reconciled before review.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Metric
            label="Assumed financial benefit"
            value={formatUSD(result.assumedBenefitCents / 100)}
            detail="Assumptions remain outside measured returns"
          />
          <Metric
            label="Projected financial benefit"
            value={formatUSD(result.projectedBenefitCents / 100)}
            detail="Projections remain outside measured returns"
          />
        </div>
        <ul className="mt-4 space-y-3">
          {record.measures.map((m) => (
            <li key={m.id} className="rounded border border-edge p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h4 className="font-medium">{m.title}</h4>
                  <p className="mt-1 text-xs text-sub">
                    {CATEGORY_LABELS[m.category]} · {m.status} ·{" "}
                    {m.verified
                      ? `Verified by ${m.verified.by}`
                      : m.status === "measured"
                        ? "Awaiting independent review"
                        : "Unverified assumption or projection"}
                  </p>
                  <p className="mt-2 font-mono text-sm">
                    {m.amountCents === null
                      ? `Nonfinancial evidence · ${record.metric}`
                      : `${formatUSD(monetaryBenefit(m) / 100)} attributed benefit`}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <button
                    className="sim-button"
                    disabled={busy}
                    onClick={() => setEdit(m.id)}
                  >
                    Edit {m.title}
                  </button>
                  <button
                    className="sim-button"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        type: "remove-value-measure",
                        workloadId,
                        measureId: m.id,
                      })
                    }
                  >
                    Remove {m.title}
                  </button>
                  {m.status === "measured" && !m.verified && (
                    <button
                      className="sim-button"
                      disabled={
                        busy ||
                        !reviewer ||
                        m.recordedBy === sim.session.identity.user
                      }
                      onClick={() =>
                        void run({
                          type: "verify-value-measure",
                          workloadId,
                          measureId: m.id,
                        })
                      }
                    >
                      Verify {m.title}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-3 break-words text-xs text-sub">
                Evidence: {m.reference || "Not supplied"}
                <br />
                Method: {m.method || "Not supplied"}
                <br />
                Recorded by {m.recordedBy}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-sub">
          Executive or Procurement can verify evidence entered by a different
          identity. Editing a claim or its performance basis removes
          verification.
        </p>
        <ValueForm
          key={`${workloadId}:${edit ?? "new"}`}
          measure={record.measures.find((m) => m.id === edit)}
          busy={busy}
          save={(measure) =>
            void run({ type: "save-value-measure", workloadId, measure })
          }
        />
        {edit && (
          <button
            className="mt-3 text-sm text-unit underline"
            onClick={() => setEdit(null)}
          >
            Add a new value measure
          </button>
        )}
      </Section>
      <Section title="Full cost">
        <p className="text-sm text-sub">
          Use costs for the same observation period. Allocate implementation
          cost explicitly; exclude model usage from the other categories to
          avoid counting it twice. Confirm zero with evidence when a category
          has no cost.
        </p>
        <div className="mt-4 rounded border border-edge p-4">
          <h4 className="font-semibold">Model usage · recorded ledger</h4>
          <p className="mt-2 font-mono">{formatUSD(result.modelCents / 100)}</p>
          <p className="mt-1 text-xs text-sub">
            {record.observation.start}–{record.observation.end} · paired with{" "}
            {record.metric} target {record.target} {record.unit}
          </p>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {COST_CATEGORIES.map((category) => (
            <CostForm
              key={`${workloadId}:${category}:${JSON.stringify(record.costs[category])}`}
              category={category}
              cost={record.costs[category]}
              busy={busy}
              reviewer={reviewer}
              currentUser={sim.session.identity.user}
              save={(cost) =>
                void run({ type: "save-full-cost", workloadId, category, cost })
              }
              verify={() =>
                void run({ type: "verify-full-cost", workloadId, category })
              }
            />
          ))}
        </div>
      </Section>
      <Section title="Decision review">
        <p className="text-sm text-sub">
          Benefit / full cost thresholds: stop below{" "}
          {record.thresholds.stopBelow}×; change below{" "}
          {record.thresholds.continueAt}×; continue at{" "}
          {record.thresholds.continueAt}×; expand at{" "}
          {record.thresholds.expandAt}× with the performance target met.
          Expansion also requires all governance gates.
        </p>
        <p className="mt-4 text-lg" role="status">
          Suggested decision:{" "}
          <strong>
            {result.recommendation === "review"
              ? "Evidence review required"
              : result.recommendation}
          </strong>
        </p>
        {result.blockers.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-shape">
            {result.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <DecisionForm
          key={`${workloadId}:${result.recommendation}`}
          recommended={result.recommendation}
          enabled={reviewer && result.recommendation !== "review"}
          canExpand={
            canExpand &&
            result.measuredRatio !== null &&
            result.measuredRatio >= record.thresholds.expandAt &&
            result.targetMet
          }
          canContinue={
            result.measuredRatio !== null &&
            result.measuredRatio >= record.thresholds.continueAt &&
            result.targetMet
          }
          busy={busy}
          save={(action, rationale) =>
            void run({
              type: "record-outcome-decision",
              workloadId,
              action,
              rationale,
            })
          }
        />
        <p className="mt-3 text-xs text-sub">
          A decision records business authorization and rationale. Implement
          changes through the separate approval workflow.
        </p>
        {latest && (
          <p className="mt-4 text-sm text-sub">
            Latest decision: {latest.action} · {latest.by} ·{" "}
            {stale
              ? "Needs renewed review: its inputs changed"
              : "Matches current evidence, cost and governance"}
          </p>
        )}
        <ol className="mt-4 space-y-3">
          {record.decisions
            .slice(-5)
            .reverse()
            .map((d, i) => (
              <li
                key={`${d.at}:${i}`}
                className="border-t border-edge pt-3 text-sm"
              >
                <strong>{d.action}</strong> · {d.by} · {d.at}
                <p className="mt-1 text-sub">{d.rationale}</p>
              </li>
            ))}
        </ol>
      </Section>
    </div>
  );
}
function PlanForm({
  record,
  busy,
  save,
}: {
  record: OutcomeRecord;
  busy: boolean;
  save: (plan: unknown) => void;
}) {
  const [draft, setDraft] = useState(record);
  const field = (
    key: "owner" | "ownerRole" | "metric" | "unit",
    label: string,
  ) => (
    <Field label={label}>
      <input
        required
        maxLength={120}
        className="sim-input w-full"
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <form
      onSubmit={submit(() => {
        const {
          owner,
          ownerRole,
          metric,
          unit,
          baseline,
          observation,
          direction,
          target,
          thresholds,
        } = draft;
        save({
          owner,
          ownerRole,
          metric,
          unit,
          baseline,
          observation,
          direction,
          target,
          thresholds,
        });
      })}
      className="space-y-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("owner", "Accountable owner")}
        {field("ownerRole", "Owner role")}
        {field("metric", "Primary outcome metric")}
        {field("unit", "Metric unit")}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {(["baseline", "observation"] as const).map((key) => (
          <fieldset
            key={key}
            className="space-y-3 rounded border border-edge p-4"
          >
            <legend className="px-1 text-sm">
              {key === "baseline" ? "Pre-AI baseline" : "AI observation"}
            </legend>
            <Field label={`${key} performance`}>
              <input
                type="number"
                required
                step="any"
                className="sim-input w-full"
                value={draft[key].value}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: { ...draft[key], value: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {(["start", "end"] as const).map((bound) => (
                <Field key={bound} label={`${key} ${bound}`}>
                  <input
                    type="date"
                    required
                    className="sim-input min-w-0 w-full"
                    value={draft[key][bound]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [key]: { ...draft[key], [bound]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
            <Field label={`${key} evidence reference`}>
              <input
                required
                maxLength={500}
                className="sim-input w-full"
                value={draft[key].reference}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: { ...draft[key], reference: e.target.value },
                  })
                }
              />
            </Field>
          </fieldset>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Desired direction">
          <select
            className="sim-input w-full"
            value={draft.direction}
            onChange={(e) =>
              setDraft({
                ...draft,
                direction: e.target.value as "higher" | "lower",
              })
            }
          >
            <option value="higher">Higher is better</option>
            <option value="lower">Lower is better</option>
          </select>
        </Field>
        <Field label="Performance target">
          <input
            type="number"
            step="any"
            required
            className="sim-input w-full"
            value={draft.target}
            onChange={(e) =>
              setDraft({ ...draft, target: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-3 text-sm">
          Decision thresholds · benefit / full cost
        </legend>
        {(["stopBelow", "continueAt", "expandAt"] as const).map((key, i) => (
          <Field
            key={key}
            label={
              ["Stop below ratio", "Continue at ratio", "Expand at ratio"][i]
            }
          >
            <input
              type="number"
              min="0"
              max="1000"
              step="0.01"
              required
              className="sim-input w-full"
              value={draft.thresholds[key]}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    [key]: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
        ))}
      </fieldset>
      <p className="text-xs text-sub">
        Changing the observation dates clears supplemental cost amounts so they
        can be entered for the new period.
      </p>
      <button className="sim-button" disabled={busy}>
        Save owner and baseline
      </button>
    </form>
  );
}
function ValueForm({
  measure,
  busy,
  save,
}: {
  measure?: ValueMeasure;
  busy: boolean;
  save: (measure: unknown) => void;
}) {
  const [draft, setDraft] = useState({
    id: measure?.id ?? "",
    title: measure?.title ?? "",
    category: measure?.category ?? "revenue",
    status: measure?.status ?? "projected",
    amount:
      measure?.amountCents == null ? "" : String(measure.amountCents / 100),
    contributionMarginPct: measure?.contributionMarginPct ?? 100,
    attributionPct: measure?.attributionPct ?? 100,
    reference: measure?.reference ?? "",
    method: measure?.method ?? "",
  });
  const financial =
    draft.category === "revenue" || draft.category === "cost_savings";
  return (
    <form
      className="mt-5 space-y-3 rounded border border-edge p-4"
      onSubmit={submit(() =>
        save({
          ...draft,
          id: draft.id || crypto.randomUUID(),
          amountCents: financial
            ? Math.round(Number(draft.amount) * 100)
            : null,
        }),
      )}
    >
      <h4 className="font-semibold">
        {measure ? "Edit value evidence" : "Add value evidence"}
      </h4>
      <Field label="Value measure title">
        <input
          className="sim-input w-full"
          required
          maxLength={160}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Value category">
          <select
            className="sim-input w-full"
            value={draft.category}
            onChange={(e) =>
              setDraft({
                ...draft,
                category: e.target.value as ValueMeasure["category"],
              })
            }
          >
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Value evidence status">
          <StatusSelect
            value={draft.status}
            onChange={(status) => setDraft({ ...draft, status })}
          />
        </Field>
      </div>
      {financial && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label={
              draft.category === "revenue"
                ? "Incremental revenue (USD)"
                : "Realized spending reduction (USD)"
            }
          >
            <input
              required
              type="number"
              min="0"
              max="10000000000"
              step="0.01"
              className="sim-input w-full"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          </Field>
          <Field label="AI attribution (%)">
            <input
              required
              type="number"
              min="0"
              max="100"
              step="0.01"
              className="sim-input w-full"
              value={draft.attributionPct}
              onChange={(e) =>
                setDraft({ ...draft, attributionPct: Number(e.target.value) })
              }
            />
          </Field>
          {draft.category === "revenue" && (
            <Field label="Contribution margin (%)">
              <input
                required
                type="number"
                min="0"
                max="100"
                step="0.01"
                className="sim-input w-full"
                value={draft.contributionMarginPct}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    contributionMarginPct: Number(e.target.value),
                  })
                }
              />
            </Field>
          )}
        </div>
      )}
      <Field label="Value evidence reference">
        <input
          required={draft.status === "measured"}
          maxLength={500}
          className="sim-input w-full"
          value={draft.reference}
          onChange={(e) => setDraft({ ...draft, reference: e.target.value })}
        />
      </Field>
      <Field label="Attribution or evaluation method">
        <textarea
          required={draft.status === "measured"}
          maxLength={500}
          className="sim-input w-full"
          value={draft.method}
          onChange={(e) => setDraft({ ...draft, method: e.target.value })}
        />
      </Field>
      <p className="text-xs text-sub">
        Claim applies to the initiative observation period. Use a source
        reference and explain how the effect was isolated from other changes.
      </p>
      <button className="sim-button" disabled={busy}>
        Save value evidence
      </button>
    </form>
  );
}
function CostForm({
  category,
  cost,
  busy,
  reviewer,
  currentUser,
  save,
  verify,
}: {
  category: AdditionalCostCategory;
  cost: AdditionalCost;
  busy: boolean;
  reviewer: boolean;
  currentUser: string;
  save: (cost: AdditionalCost) => void;
  verify: () => void;
}) {
  const [amount, setAmount] = useState(
    cost.cents === null ? "" : String(cost.cents / 100),
  );
  const [evidenceStatus, setStatus] = useState(cost.status);
  const [reference, setReference] = useState(cost.reference);
  return (
    <form
      className="space-y-3 rounded border border-edge p-4"
      onSubmit={submit(() =>
        save({
          cents: amount === "" ? null : Math.round(Number(amount) * 100),
          status: evidenceStatus,
          reference,
        }),
      )}
    >
      <h4 className="font-semibold">{COST_LABELS[category]}</h4>
      <p className="text-xs text-sub">
        {cost.verified
          ? `Verified by ${cost.verified.by}`
          : cost.status === "measured"
            ? "Awaiting independent review"
            : "Not eligible for measured-return review"}
        {cost.recordedBy ? ` · Recorded by ${cost.recordedBy}` : ""}
      </p>
      <Field label={`${COST_LABELS[category]} cost (USD)`}>
        <input
          type="number"
          min="0"
          max="10000000000"
          step="0.01"
          required={evidenceStatus === "measured"}
          className="sim-input w-full"
          value={amount}
          placeholder="Unknown"
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label={`${COST_LABELS[category]} status`}>
        <StatusSelect value={evidenceStatus} onChange={setStatus} />
      </Field>
      <Field label={`${COST_LABELS[category]} evidence`}>
        <input
          className="sim-input w-full"
          required={evidenceStatus === "measured"}
          maxLength={500}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>
      <button className="sim-button" disabled={busy}>
        Save {COST_LABELS[category].toLowerCase()} cost
      </button>
      {cost.status === "measured" && !cost.verified && (
        <button
          type="button"
          className="sim-button"
          disabled={busy || !reviewer || cost.recordedBy === currentUser || !cost.recordedBy}
          onClick={verify}
        >
          Verify {COST_LABELS[category].toLowerCase()} cost
        </button>
      )}
    </form>
  );
}
function DecisionForm({
  recommended,
  enabled,
  canExpand,
  canContinue,
  busy,
  save,
}: {
  recommended: OutcomeAction | "review";
  enabled: boolean;
  canExpand: boolean;
  canContinue: boolean;
  busy: boolean;
  save: (action: OutcomeAction, rationale: string) => void;
}) {
  const [action, setAction] = useState<OutcomeAction>(
    recommended === "review" ? "change" : recommended,
  );
  const [rationale, setRationale] = useState("");
  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={submit(() => save(action, rationale))}
    >
      <Field label="Business decision">
        <select
          className="sim-input w-full"
          value={action}
          onChange={(e) => setAction(e.target.value as OutcomeAction)}
        >
          {(["continue", "expand", "change", "stop"] as const).map((a) => (
            <option
              key={a}
              value={a}
              disabled={
                (a === "expand" && !canExpand) ||
                (a === "continue" && !canContinue)
              }
            >
              {a}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Decision rationale">
        <textarea
          className="sim-input w-full"
          required
          minLength={10}
          maxLength={1000}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <button
        className="sim-button"
        disabled={busy || !enabled || (action === "expand" && !canExpand)}
      >
        Record business decision
      </button>
    </form>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 text-xs text-sub">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
function StatusSelect({
  value,
  onChange,
}: {
  value: AdditionalCost["status"];
  onChange: (status: AdditionalCost["status"]) => void;
}) {
  return (
    <select
      className="sim-input w-full"
      value={value}
      onChange={(e) => onChange(e.target.value as AdditionalCost["status"])}
    >
      <option value="assumed">Assumed</option>
      <option value="projected">Projected</option>
      <option value="measured">Measured</option>
    </select>
  );
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded border border-edge bg-deep p-4">
      <p className="text-xs text-sub">{label}</p>
      <p className="mt-2 font-mono text-lg">{value}</p>
      <p className="mt-2 text-xs text-sub">{detail}</p>
    </div>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-edge bg-deep p-4 sm:p-5">
      <h3 className="mb-4 text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}
function submit(action: () => void) {
  return (e: FormEvent) => {
    e.preventDefault();
    action();
  };
}
