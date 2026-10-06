import { evaluateOutcome } from "@/outcomes/model";
import { COST_CATEGORIES } from "@/outcomes/types";
import type { SimIdentity, Workspace } from "@/simulation/types";
export const FRANK = Object.freeze({
  name: "Frank Coster",
  role: "Your FinOps accountability partner",
  personality:
    "Calm, candid and precise. Explain the evidence, name the owner, and make the next step clear.",
  purpose:
    "Help people understand what AI is worth and make accountable decisions.",
  authority:
    "Read saved tenant evidence, explain gaps and draft review tasks. People verify claims and authorize decisions.",
});
export const FRANK_PROMPTS = [
  "What needs my attention?",
  "Explain the full cost",
  "Who owns the baseline?",
  "Can we expand this initiative?",
] as const;
export interface FrankGuide {
  name: string;
  workloadId: string;
  initiative: string;
  revision: number;
  message: string;
  blockers: string[];
  steps: {
    key: string;
    title: string;
    detail: string;
    ready: boolean;
    href: "/outcomes" | "/workloads";
  }[];
  authority: string;
}
export function frankGuide(
  s: Workspace,
  actor: SimIdentity,
  workloadId: string,
  question = "",
): FrankGuide {
  const w = s.workloads.find((w) => w.id === workloadId);
  const o = s.outcomes[workloadId];
  if (!w || !o) throw new Error("Initiative not found.");
  const e = evaluateOutcome(o, s.ledger);
  const gatesReady =
    w.governance.policy_check &&
    w.governance.ethics_review &&
    w.governance.cost_approval &&
    w.governance.scale_authorized;
  const dollars = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(cents / 100);
  const ratio =
    e.measuredRatio === null
      ? "Measured return is awaiting complete costs and reviewed financial evidence."
      : `Measured value / full cost is ${e.measuredRatio.toFixed(2)}×.`;
  const cost =
    e.totalCostCents === null
      ? `Known cost is ${dollars(e.estimatedCostCents)}; the full cost is incomplete.`
      : `Full cost is ${dollars(e.totalCostCents)} (${e.costsMeasured ? "measured" : "estimated"}).`;
  const owner = `${o.owner} owns ${o.metric}. The baseline is ${o.baseline.value} ${o.unit}; observed performance is ${o.observation.value} ${o.unit}, against a target of ${o.target} ${o.unit}. ${e.performanceReviewed ? `Performance evidence verified by ${o.planVerified!.by}.` : 'Performance evidence awaits independent review.'} These samples are simulated.`;
  const roleStep =
    actor.persona === "technical"
      ? "Your next step is to substantiate the comparison and cost inputs."
      : actor.persona === "procurement"
        ? "Your next step is to reconcile financial evidence and review claims recorded by someone else."
        : "Your next step is to review the evidence with its owner before authorizing a business decision.";
  const q = question.toLowerCase();
  let message: string;
  if (/expand|scale|decision|stop|continue/.test(q))
    message = `${e.recommendation === "review" || !gatesReady ? "Expansion is not ready for approval." : `The evidence suggests ${e.recommendation}.`} ${ratio} ${!gatesReady ? "All four governance gates must pass before expansion." : "Governance gates are complete."} A person must record the business decision.`;
  else if (/cost|spend/.test(q))
    message = `${cost} ${ratio} Model usage comes from the observation-period ledger. Infrastructure, implementation, oversight and labor require supporting records; unknown costs are not zero.`;
  else if (/baseline|owner|accountab/.test(q))
    message = `${owner} Compare equal observation windows and retain both source references.`;
  else if (/permission|credential|security|tool|authoriz/.test(q))
    message = `${FRANK.authority} I have no provider credentials, shell access, external messaging or cloud execution authority in this simulation.`;
  else
    message = `${e.blockers.length ? `I found ${e.blockers.length} evidence gaps for ${w.name}.` : `The measured evidence suggests ${e.recommendation} for ${w.name}.`} ${cost} ${ratio} ${roleStep}`;
  return {
    name: FRANK.name,
    workloadId,
    initiative: w.name,
    revision: s.revision,
    message,
    blockers: e.blockers,
    steps: [
      {
        key: "owner",
        title: "Owner & baseline",
        detail: owner,
        ready: !!o.owner && !!o.baseline.reference && e.equalDuration && e.performanceReviewed,
        href: "/outcomes",
      },
      {
        key: "value",
        title: "Value evidence",
        detail: `${o.measures.filter((m) => m.status === "measured" && m.verified).length} reviewed measured claims. Assumed and projected value stay separate.`,
        ready:
          o.measures.some(
            (m) =>
              ["revenue", "cost_savings"].includes(m.category) &&
              m.status === "measured" &&
              m.verified,
          ) && !o.measures.some((m) => m.status === "measured" && !m.verified),
        href: "/outcomes",
      },
      {
        key: "cost",
        title: "Full cost",
        detail: `${COST_CATEGORIES.filter((k) => o.costs[k].cents !== null).length}/4 supporting cost categories recorded. ${ratio}`,
        ready: e.costsMeasured,
        href: "/outcomes",
      },
      {
        key: "decision",
        title: "Decision & governance",
        detail: `Evidence recommendation: ${e.recommendation}. ${gatesReady ? "Four governance gates passed." : "Governance review is required before expansion."}`,
        ready: e.recommendation !== "review" && gatesReady,
        href: "/workloads",
      },
    ],
    authority: FRANK.authority,
  };
}
