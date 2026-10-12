import { describe, expect, it } from "vitest";
import { seedWorkspace, executeCommand } from "@/simulation/server/workflow";
import { estimateTca, evaluateOutcome, outcomeBasis, TCA_ESTIMATE_RATES } from "./model";
import { WORKLOADS } from "@/data/workloads";
const tech = { tenant: "acme", user: "Alex", persona: "technical" as const };
const buyer = {
  tenant: "acme",
  user: "Jordan",
  persona: "procurement" as const,
};
describe("outcome accountability", () => {
  it("does not treat assumed value or incomplete cost as a measured return", () => {
    const s = seedWorkspace();
    const w = s.workloads[0];
    const result = evaluateOutcome(
      s.outcomes[w.id],
      s.ledger.filter((r) => r.workloadId === w.id),
    );
    expect(result.recommendation).toBe("review");
    expect(result.measuredBenefitCents).toBe(0);
    expect(result.missingCosts.length).toBeGreaterThan(0);
  });
  it("uses attribution and margin, requires verification, and separates nonfinancial gains", () => {
    let s = seedWorkspace();
    const id = s.workloads[0].id;
    const measure = {
      verified: { by: "forged reviewer", at: "2026-06-25" },
      id: "revenue-1",
      category: "revenue",
      title: "Incremental sales",
      status: "measured",
      amountCents: 100000,
      contributionMarginPct: 40,
      attributionPct: 50,
      reference: "sales ledger June sample",
      method: "Matched control cohort",
    };
    s = executeCommand(s, tech, {
      type: "save-value-measure",
      workloadId: id,
      measure,
    });
    expect(evaluateOutcome(s.outcomes[id], s.ledger).measuredBenefitCents).toBe(
      0,
    );
    expect(() =>
      executeCommand(s, tech, {
        type: "verify-value-measure",
        workloadId: id,
        measureId: measure.id,
      }),
    ).toThrow(/permission/);
    s = executeCommand(s, buyer, {
      type: "verify-value-measure",
      workloadId: id,
      measureId: measure.id,
    });
    expect(
      evaluateOutcome(
        s.outcomes[id],
        s.ledger.filter((r) => r.workloadId === id),
      ).measuredBenefitCents,
    ).toBe(20000);
    s = executeCommand(s, tech, {
      type: "save-value-measure",
      workloadId: id,
      measure: { ...measure, category: "quality", amountCents: null },
    });
    expect(
      s.outcomes[id].measures.find((m) => m.id === measure.id)?.verified,
    ).toBeUndefined();
    expect(evaluateOutcome(s.outcomes[id], s.ledger).measuredBenefitCents).toBe(
      0,
    );
  });
  it("rejects inverted periods and thresholds, missing measured evidence and forged verification", () => {
    const s = seedWorkspace();
    const id = s.workloads[0].id;
    const o = s.outcomes[id];
    expect(() =>
      executeCommand(s, tech, {
        type: "save-outcome-plan",
        workloadId: id,
        plan: {
          ...o,
          baseline: { ...o.baseline, start: "2026-05-25", end: "2026-05-01" },
        },
      }),
    ).toThrow(/period/);
    expect(() =>
      executeCommand(s, buyer, {
        type: "save-outcome-plan",
        workloadId: id,
        plan: {
          ...o,
          thresholds: { stopBelow: 3, continueAt: 1, expandAt: 2 },
        },
      }),
    ).toThrow(/threshold/i);
    expect(() =>
      executeCommand(s, tech, {
        type: "save-value-measure",
        workloadId: id,
        measure: {
          id: "bad",
          category: "cost_savings",
          title: "Claim",
          status: "measured",
          amountCents: 12,
          attributionPct: 100,
          contributionMarginPct: 100,
          reference: "",
          method: "",
        },
      }),
    ).toThrow(/evidence/);
  });
});
it("only permits expansion above its threshold and keeps decisions stale after cost changes", () => {
  let s = seedWorkspace();
  const id = s.workloads[0].id;
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId: id,
    plan: { ...s.outcomes[id], target: 82 },
  });
  s = executeCommand(s, buyer, {
    type: "verify-outcome-plan",
    workloadId: id,
  });
  for (const category of [
    "infrastructure",
    "implementation",
    "oversight",
    "labor",
  ])
    s = executeCommand(s, tech, {
      type: "save-full-cost",
      workloadId: id,
      category,
      cost: {
        cents: 10000,
        status: "measured",
        reference: "Fixture payroll and invoices",
      },
    });
  for (const category of [
    "infrastructure",
    "implementation",
    "oversight",
    "labor",
  ])
    s = executeCommand(s, buyer, {
      type: "verify-full-cost",
      workloadId: id,
      category,
    });
  s = executeCommand(s, tech, {
    type: "save-value-measure",
    workloadId: id,
    measure: {
      id: "cash",
      category: "cost_savings",
      title: "Realized cash saving",
      status: "measured",
      amountCents: 100000,
      contributionMarginPct: 100,
      attributionPct: 100,
      reference: "Actual invoice delta",
      method: "Matched period comparison",
    },
  });
  s = executeCommand(s, buyer, {
    type: "verify-value-measure",
    workloadId: id,
    measureId: "cash",
  });
  expect(evaluateOutcome(s.outcomes[id], s.ledger).recommendation).toBe("stop");
  expect(() =>
    executeCommand(s, buyer, {
      type: "record-outcome-decision",
      workloadId: id,
      action: "expand",
      rationale: "We should scale this initiative",
    }),
  ).toThrow(/threshold/);
  s = executeCommand(s, buyer, {
    type: "record-outcome-decision",
    workloadId: id,
    action: "stop",
    rationale: "Measured return is below the stop threshold",
  });
  expect(s.outcomes[id].decisions[0].action).toBe("stop");
  const priorBasis = s.outcomes[id].decisions[0].basis;
  s = executeCommand(s, tech, {
    type: "save-full-cost",
    workloadId: id,
    category: "labor",
    cost: { cents: 20000, status: "measured", reference: "Updated invoice" },
  });
  expect(
    outcomeBasis(s.outcomes[id], s.ledger, s.workloads[0].governance),
  ).not.toBe(priorBasis);
  expect(s.ledger).toEqual(seedWorkspace().ledger);
});
it("clears period-specific costs and verification when the reporting window changes", () => {
  let s = seedWorkspace();
  const id = s.workloads[0].id;
  s = executeCommand(s, tech, {
    type: "save-full-cost",
    workloadId: id,
    category: "labor",
    cost: { cents: 100, status: "measured", reference: "Timesheet" },
  });
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId: id,
    plan: {
      ...s.outcomes[id],
      observation: { ...s.outcomes[id].observation, end: "2026-06-24" },
    },
  });
  expect(s.outcomes[id].costs.labor.cents).toBeNull();
  expect(evaluateOutcome(s.outcomes[id], s.ledger).equalDuration).toBe(false);
});
it("requires independent verification before measured full cost can establish return", () => {
  let s = seedWorkspace();
  const id = s.workloads[0].id;
  s = executeCommand(s, tech, {
    type: "save-full-cost",
    workloadId: id,
    category: "labor",
    cost: { cents: 100, status: "measured", reference: "Timesheet" },
  });
  expect(evaluateOutcome(s.outcomes[id], s.ledger).unverifiedCosts).toContain("labor");
  expect(() =>
    executeCommand(s, tech, {
      type: "verify-full-cost",
      workloadId: id,
      category: "labor",
    }),
  ).toThrow(/permission/);
  expect(() =>
    executeCommand(s, { ...buyer, user: tech.user }, {
      type: "verify-full-cost",
      workloadId: id,
      category: "labor",
    }),
  ).toThrow(/separate identity/);
  s = executeCommand(s, buyer, {
    type: "verify-full-cost",
    workloadId: id,
    category: "labor",
  });
  expect(s.outcomes[id].costs.labor.verified?.by).toBe(buyer.user);
  s = executeCommand(s, tech, {
    type: "save-full-cost",
    workloadId: id,
    category: "labor",
    cost: { cents: 200, status: "measured", reference: "Revised timesheet" },
  });
  expect(s.outcomes[id].costs.labor.verified).toBeUndefined();
});
it("requires independent review of baseline and observation evidence and invalidates review on edits", () => {
  let s = seedWorkspace();
  const id = s.workloads[0].id;
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId: id,
    plan: { ...s.outcomes[id], target: 82 },
  });
  expect(s.outcomes[id].planRecordedBy).toBe(tech.user);
  expect(evaluateOutcome(s.outcomes[id], s.ledger).performanceReviewed).toBe(false);
  expect(() =>
    executeCommand(s, tech, { type: "verify-outcome-plan", workloadId: id }),
  ).toThrow(/permission/);
  expect(() =>
    executeCommand(s, { ...buyer, user: tech.user }, {
      type: "verify-outcome-plan",
      workloadId: id,
    }),
  ).toThrow(/separate identity/);
  s = executeCommand(s, buyer, { type: "verify-outcome-plan", workloadId: id });
  expect(s.outcomes[id].planVerified?.by).toBe(buyer.user);
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId: id,
    plan: s.outcomes[id],
  });
  expect(s.outcomes[id].planVerified?.by).toBe(buyer.user);
  const verified = s;
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId: id,
    plan: { ...s.outcomes[id], target: 83 },
  });
  expect(s.outcomes[id].planVerified).toBeUndefined();
  expect(s.outcomes[id].planRecordedBy).toBe(tech.user);
  expect(verified.outcomes[id].planVerified?.by).toBe(buyer.user);
});
it("does not silently count missing model-cost coverage as zero expense", () => {
  const s = seedWorkspace();
  const o = s.outcomes[s.workloads[0].id];
  for (const category of [
    "infrastructure",
    "implementation",
    "oversight",
    "labor",
  ] as const)
    o.costs[category] = {
      cents: 0,
      status: "measured",
      reference: "Confirmed zero fixture",
    };
  const r = evaluateOutcome(o, []);
  expect(r.totalCostCents).toBeNull();
  expect(r.ledgerComplete).toBe(false);
  expect(r.recommendation).toBe("review");
});

describe("read-only TCA estimate (audit C9)", () => {
  it("reuses the outcomes module's four cost categories plus model usage", () => {
    const tca = estimateTca(WORKLOADS[0]);
    expect(tca.lines.map((l) => l.category)).toEqual([
      "model_usage",
      "infrastructure",
      "implementation",
      "oversight",
      "labor",
    ]);
  });

  it("model usage + infrastructure reconstruct the headline spend (no double count)", () => {
    const w = WORKLOADS[0];
    const tca = estimateTca(w);
    const inside = tca.lines
      .filter((l) => l.inHeadlineSpend)
      .reduce((n, l) => n + l.cents, 0);
    expect(inside).toBe(Math.round(w.costs.monthly_spend * 100));
    expect(tca.headlineSpendCents).toBe(Math.round(w.costs.monthly_spend * 100));
  });

  it("estimates the three missing categories at the default rates, marked assumed", () => {
    const w = WORKLOADS[0];
    const tca = estimateTca(w);
    const spendCents = Math.round(w.costs.monthly_spend * 100);
    for (const line of tca.lines) {
      if (line.category === "model_usage" || line.category === "infrastructure") {
        expect(line.status).toBe("projected");
      } else {
        expect(line.status).toBe("assumed");
        expect(line.cents).toBe(Math.round(spendCents * TCA_ESTIMATE_RATES[line.category]));
        expect(line.inHeadlineSpend).toBe(false);
      }
    }
  });

  it("full cost = headline spend + the three estimated categories", () => {
    const w = WORKLOADS[0];
    const tca = estimateTca(w);
    const additions = tca.lines
      .filter((l) => !l.inHeadlineSpend)
      .reduce((n, l) => n + l.cents, 0);
    expect(tca.fullCostCents).toBe(tca.headlineSpendCents + additions);
  });

  it("pairs the defensible numerator with the full cost — the C9 ratio", () => {
    const w = WORKLOADS.find((x) => x.value.total_value > 0)!;
    const tca = estimateTca(w);
    expect(tca.fullCostRatio).not.toBeNull();
    expect(tca.fullCostRatio!).toBeCloseTo(
      (w.value.total_value * 100) / tca.fullCostCents,
      6,
    );
    // Full cost exceeds the headline spend, so the full-cost return is strictly
    // lower than the headline ratio — the pairing never flatters.
    expect(tca.fullCostRatio!).toBeLessThan(
      w.value.value_ratio === 0 ? Infinity : w.value.total_value / w.costs.monthly_spend,
    );
  });

  it("never reports a positive full-cost ratio for a non-positive numerator", () => {
    const negative = WORKLOADS.find((x) => x.value.total_value <= 0);
    expect(negative).toBeDefined();
    const tca = estimateTca(negative!);
    expect(tca.fullCostRatio!).toBeLessThanOrEqual(0);
  });
});
