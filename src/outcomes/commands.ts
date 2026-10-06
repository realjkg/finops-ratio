import type { Command, SimIdentity, Workspace } from "@/simulation/types";
import {
  COST_CATEGORIES,
  type EvidenceStatus,
  type PerformanceSample,
  type ValueMeasure,
  type OutcomeAction,
  type OutcomeRecord,
} from "./types";
import { evaluateOutcome, outcomeBasis } from "./model";
// Validation errors are translated to HTTP 400 by the workflow boundary.
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function obj(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an outcome object.",
  );
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, min = 1, max = 500): string {
  assert(
    typeof value === "string" &&
      value.trim().length >= min &&
      value.length <= max,
    `${name} is required (${min}–${max} characters).`,
  );
  return value.trim();
}
function number(value: unknown, name: string, min = 0, max = 1e12): number {
  assert(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `${name} must be a finite number between ${min} and ${max}.`,
  );
  return value;
}
function status(value: unknown): EvidenceStatus {
  assert(
    ["assumed", "projected", "measured"].includes(String(value)),
    "Unknown evidence status.",
  );
  return value as EvidenceStatus;
}
function date(value: unknown): string {
  const v = text(value, "Period date", 10, 10);
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Invalid reporting period date.",
  );
  return v;
}
function sample(value: unknown): PerformanceSample {
  const x = obj(value);
  const start = date(x.start);
  const end = date(x.end);
  assert(start <= end, "Reporting period must start on or before its end.");
  return {
    value: number(x.value, "Performance", -1e12),
    start,
    end,
    reference: text(x.reference, "Performance evidence"),
  };
}
export const OUTCOME_COMMANDS = [
  "save-outcome-plan",
  "verify-outcome-plan",
  "save-value-measure",
  "remove-value-measure",
  "verify-value-measure",
  "save-full-cost",
  "verify-full-cost",
  "record-outcome-decision",
];
export function executeOutcomeCommand(
  s: Workspace,
  actor: SimIdentity,
  command: Command,
  now: string,
): void {
  const id = String(command.workloadId);
  const o = s.outcomes[id];
  assert(o, "Outcome record not found.");
  switch (command.type) {
    case "save-outcome-plan": {
      const p = obj(command.plan);
      const thresholds = obj(p.thresholds);
      const next: Pick<
        OutcomeRecord,
        | "owner"
        | "ownerRole"
        | "metric"
        | "unit"
        | "baseline"
        | "observation"
        | "direction"
        | "target"
        | "thresholds"
      > = {
        owner: text(p.owner, "Accountable owner", 2, 120),
        ownerRole: text(p.ownerRole, "Owner role", 2, 120),
        metric: text(p.metric, "Outcome metric", 2, 120),
        unit: text(p.unit, "Metric unit", 1, 50),
        baseline: sample(p.baseline),
        observation: sample(p.observation),
        direction: p.direction as "higher" | "lower",
        target: number(p.target, "Target", -1e12),
        thresholds: {
          stopBelow: number(thresholds.stopBelow, "Stop threshold", 0, 1000),
          continueAt: number(
            thresholds.continueAt,
            "Continue threshold",
            0,
            1000,
          ),
          expandAt: number(thresholds.expandAt, "Expand threshold", 0, 1000),
        },
      };
      const previous = {
        owner: o.owner,
        ownerRole: o.ownerRole,
        metric: o.metric,
        unit: o.unit,
        baseline: o.baseline,
        observation: o.observation,
        direction: o.direction,
        target: o.target,
        thresholds: o.thresholds,
      };
      assert(
        ["higher", "lower"].includes(next.direction),
        "Choose a metric direction.",
      );
      assert(
        next.baseline.end < next.observation.start,
        "The pre-AI baseline period must precede the observation period.",
      );
      assert(
        next.thresholds.stopBelow < next.thresholds.continueAt &&
          next.thresholds.continueAt < next.thresholds.expandAt,
        "Use ordered thresholds: stop < continue < expand.",
      );
      assert(
        next.observation.end <= s.asOf.slice(0, 10),
        "Observation period cannot exceed the available billing date.",
      );
      // Moving the attribution window or performance basis invalidates previous reviews.
      if (
        JSON.stringify({
          baseline: o.baseline,
          observation: o.observation,
          metric: o.metric,
          unit: o.unit,
        }) !==
        JSON.stringify({
          baseline: next.baseline,
          observation: next.observation,
          metric: next.metric,
          unit: next.unit,
        })
      )
        o.measures.forEach((m) => {
          delete m.verified;
        });
      if (
        o.observation.start !== next.observation.start ||
        o.observation.end !== next.observation.end
      )
        COST_CATEGORIES.forEach((k) => {
          o.costs[k] = { cents: null, status: "assumed", reference: "" };
        });
      Object.assign(o, next);
      if (!o.planRecordedBy || JSON.stringify(previous) !== JSON.stringify(next)) {
        o.planRecordedBy = actor.user;
        delete o.planVerified;
      }
      break;
    }
    case "verify-outcome-plan": {
      assert(
        o.planRecordedBy,
        "Re-save this legacy baseline before review so its recorder is known.",
      );
      assert(
        o.baseline.reference && o.observation.reference,
        "Baseline review requires supporting evidence for both periods.",
      );
      assert(
        o.planRecordedBy !== actor.user,
        "Ask a separate identity to verify the baseline and observation evidence.",
      );
      o.planVerified = { by: actor.user, at: now };
      break;
    }
    case "save-value-measure": {
      const m = obj(command.measure);
      const category = text(m.category, "Value category");
      assert(
        ["revenue", "cost_savings", "quality", "risk"].includes(category),
        "Unknown value category.",
      );
      const financial = category === "revenue" || category === "cost_savings";
      const next: ValueMeasure = {
        recordedBy: actor.user,
        id: text(m.id, "Measure id", 1, 80),
        category: category as ValueMeasure["category"],
        title: text(m.title, "Value measure", 2, 160),
        status: status(m.status),
        amountCents: financial ? number(m.amountCents, "Value cents") : null,
        contributionMarginPct: number(
          m.contributionMarginPct,
          "Contribution margin",
          0,
          100,
        ),
        attributionPct: number(m.attributionPct, "Attribution", 0, 100),
        reference:
          typeof m.reference === "string"
            ? m.reference.trim().slice(0, 500)
            : "",
        method:
          typeof m.method === "string" ? m.method.trim().slice(0, 500) : "",
      };
      assert(
        next.amountCents === null || Number.isSafeInteger(next.amountCents),
        "Value must use whole currency cents.",
      );
      if (next.status === "measured")
        assert(
          next.reference && next.method,
          "Measured value requires supporting evidence and an attribution method.",
        );
      assert(
        o.measures.length < 100 || o.measures.some((x) => x.id === next.id),
        "Limit each initiative to 100 value measures.",
      );
      const idx = o.measures.findIndex((x) => x.id === next.id);
      if (idx < 0) o.measures.push(next);
      else o.measures[idx] = next;
      break;
    }
    case "remove-value-measure":
      o.measures = o.measures.filter((m) => m.id !== command.measureId);
      break;
    case "verify-value-measure": {
      const m = o.measures.find((x) => x.id === command.measureId);
      assert(m, "Value measure not found.");
      assert(
        m.status === "measured" && m.reference && m.method,
        "Review requires measured value with evidence and an attribution method.",
      );
      assert(
        m.recordedBy !== actor.user,
        "Ask a separate identity to verify your evidence.",
      );
      m.verified = { by: actor.user, at: now };
      break;
    }
    case "save-full-cost": {
      assert(
        COST_CATEGORIES.includes(
          command.category as (typeof COST_CATEGORIES)[number],
        ),
        "Unknown full-cost category.",
      );
      const c = obj(command.cost);
      const cents = c.cents === null ? null : number(c.cents, "Cost cents");
      assert(
        cents === null || Number.isSafeInteger(cents),
        "Cost must use whole currency cents.",
      );
      const next = {
        cents,
        status: status(c.status),
        reference:
          typeof c.reference === "string"
            ? c.reference.trim().slice(0, 500)
            : "",
        recordedBy: actor.user,
      };
      if (next.status === "measured")
        assert(
          cents !== null && next.reference,
          "Measured cost requires an amount and supporting evidence, including confirmed zero cost.",
        );
      o.costs[command.category as (typeof COST_CATEGORIES)[number]] = next;
      break;
    }
    case "verify-full-cost": {
      assert(
        COST_CATEGORIES.includes(
          command.category as (typeof COST_CATEGORIES)[number],
        ),
        "Unknown full-cost category.",
      );
      const cost = o.costs[command.category as (typeof COST_CATEGORIES)[number]];
      assert(
        cost.status === "measured" && cost.cents !== null && cost.reference,
        "Review requires a measured cost with supporting evidence.",
      );
      assert(
        cost.recordedBy,
        "Re-save this legacy cost before review so its recorder is known.",
      );
      assert(
        cost.recordedBy !== actor.user,
        "Ask a separate identity to verify this cost evidence.",
      );
      cost.verified = { by: actor.user, at: now };
      break;
    }
    case "record-outcome-decision": {
      assert(
        ["continue", "expand", "change", "stop"].includes(
          String(command.action),
        ),
        "Unknown outcome decision.",
      );
      const result = evaluateOutcome(o, s.ledger);
      assert(
        result.recommendation !== "review",
        "Complete and review the outcome evidence and full cost before recording a decision.",
      );
      if (command.action === "continue" || command.action === "expand")
        assert(
          result.targetMet &&
            result.measuredRatio !== null &&
            result.measuredRatio >=
              (command.action === "expand"
                ? o.thresholds.expandAt
                : o.thresholds.continueAt),
          "The measured return and performance target must meet the decision threshold.",
        );
      if (command.action === "expand") {
        const w = s.workloads.find((x) => x.id === id)!;
        assert(
          w.governance.policy_check &&
            w.governance.ethics_review &&
            w.governance.cost_approval &&
            w.governance.scale_authorized,
          "Expansion requires all governance gates.",
        );
      }
      assert(
        o.decisions.length < 100,
        "Limit each initiative to 100 decision records.",
      );
      o.decisions.push({
        action: command.action as OutcomeAction,
        rationale: text(command.rationale, "Decision rationale", 10, 1000),
        by: actor.user,
        at: now,
        basis: outcomeBasis(
          o,
          s.ledger,
          s.workloads.find((w) => w.id === id)!.governance,
        ),
        recommendation: result.recommendation,
      });
      break;
    }
    default:
      throw new Error("Unknown outcome action.");
  }
}
