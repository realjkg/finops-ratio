import { afterEach, expect, it, vi } from "vitest";
import { executeCommand, seedWorkspace } from "@/simulation/server/workflow";
import { SimulationDatabase } from "@/simulation/server/database";
import type { Command, SimIdentity, Workspace } from "@/simulation/types";
const tech: SimIdentity = {
  tenant: "acme",
  user: "Alex",
  persona: "technical",
};
const finance: SimIdentity = {
  tenant: "acme",
  user: "Jordan",
  persona: "procurement",
};
function command(s: Workspace, c: Command, actor = tech) {
  return executeCommand(s, actor, c);
}
function queue(s = seedWorkspace(), actor = tech) {
  return command(
    s,
    { type: "queue-agent-review", workloadId: s.workloads[0].id },
    actor,
  );
}
function claim(s: Workspace, actor = tech) {
  return command(
    s,
    { type: "claim-agent-job", jobId: s.agentJobs[0].id },
    actor,
  );
}
function process(
  s: Workspace,
  type = "process-agent-job",
  actor = tech,
  token = s.agentJobs[0].lease!.token,
) {
  return command(
    s,
    { type, jobId: s.agentJobs[0].id, leaseToken: token },
    actor,
  );
}
afterEach(() => vi.restoreAllMocks());
it("deduplicates input snapshots and produces evidence tasks without mutating domain data", () => {
  const initial = seedWorkspace();
  let s = queue(initial);
  expect(queue(s)).toBe(s);
  s = process(claim(s));
  expect(s.agentJobs[0].status).toBe("review");
  expect(s.agentJobs[0].result?.recommendation).toBe("review");
  expect(s.agentJobs[0].result?.measuredRatio).toBeNull();
  expect(s.outcomes).toEqual(initial.outcomes);
  expect(s.workloads).toEqual(initial.workloads);
  expect(s.ledger).toEqual(initial.ledger);
  expect(s.audit.map((a) => a.action)).toEqual([
    "queue-agent-review",
    "claim-agent-job",
    "process-agent-job",
  ]);
});
it("restricts processing and independent approval to their authenticated roles", () => {
  const s = queue(seedWorkspace(), finance);
  expect(() => claim(s, finance)).toThrow(/permission/);
  const result = process(claim(s));
  const review = {
    type: "review-agent-proposal",
    jobId: result.agentJobs[0].id,
    resolution: "accepted",
    rationale: "Evidence gaps will be resolved before any decision.",
  };
  expect(() => command(result, review)).toThrow(/permission/);
  expect(() => command(result, review, finance)).toThrow(/different person/);
  const accepted = command(result, review, {
    ...finance,
    user: "Morgan",
    persona: "executive",
  });
  expect(accepted.agentJobs[0].status).toBe("accepted");
  expect(accepted.outcomes).toEqual(result.outcomes);
});
it("rejects forged and foreign processing leases", () => {
  const s = claim(queue());
  expect(() => process(s, "process-agent-job", tech, "forged")).toThrow(
    /lease/,
  );
  expect(() =>
    process(s, "process-agent-job", { ...tech, user: "Other worker" }),
  ).toThrow(/lease/);
  expect(() => claim(s)).toThrow(/not available/);
});
it("recovers an expired lease and refuses completion from its previous holder", () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const s = claim(queue());
    const old = s.agentJobs[0].lease!.token;
    vi.setSystemTime(now + 60_001);
    expect(() => process(s)).toThrow(/lease/);
    const recovered = claim(s);
    expect(recovered.agentJobs[0].attempts).toBe(2);
    expect(() => process(recovered, "process-agent-job", tech, old)).toThrow(
      /lease/,
    );
    expect(process(recovered).agentJobs[0].status).toBe("review");
  } finally {
    vi.useRealTimers();
  }
});
it("bounds recovery attempts and allows human dismissal of exhausted jobs", () => {
  let s = queue();
  for (let i = 0; i < 3; i++) {
    s = process(claim(s), "fail-agent-job");
    if (i < 2)
      s = command(s, { type: "retry-agent-job", jobId: s.agentJobs[0].id });
  }
  expect(() =>
    command(s, { type: "retry-agent-job", jobId: s.agentJobs[0].id }),
  ).toThrow(/attempt limit/);
  const dismissed = command(
    s,
    {
      type: "review-agent-proposal",
      jobId: s.agentJobs[0].id,
      resolution: "dismissed",
      rationale: "Investigate the processor before retrying.",
    },
    finance,
  );
  expect(dismissed.agentJobs[0].status).toBe("dismissed");
});
it("blocks stale processing and stale acceptance while allowing new evidence reviews", () => {
  let s = claim(queue());
  s.outcomes[s.workloads[0].id].owner = "New owner";
  expect(process(s).agentJobs[0].error).toMatch(/Evidence changed/);
  s = queue();
  s = process(claim(s));
  s.outcomes[s.workloads[0].id].target = 90;
  expect(() =>
    command(
      s,
      {
        type: "review-agent-proposal",
        jobId: s.agentJobs[0].id,
        resolution: "accepted",
        rationale: "Accept the proposed followup work.",
      },
      finance,
    ),
  ).toThrow(/stale/);
  expect(queue(s).agentJobs).toHaveLength(2);
});
it("persists idempotent queue commands and prevents another tenant claiming a job", () => {
  const db = new SimulationDatabase(":memory:");
  try {
    const s = db.read("acme");
    const c = { type: "queue-agent-review", workloadId: s.workloads[0].id };
    const next = db.command(tech, s.revision, "agent-queue-id", c);
    expect(db.command(tech, s.revision, "agent-queue-id", c)).toEqual(next);
    const other = { ...tech, tenant: "northstar" };
    expect(() =>
      db.command(other, 0, "foreign-claim-id", {
        type: "claim-agent-job",
        jobId: next.agentJobs[0].id,
      }),
    ).toThrow(/this tenant/);
    expect(db.read("northstar").agentJobs).toEqual([]);
    expect(db.integrity()).toBe(true);
  } finally {
    db.close();
  }
});
it('lets every persona request Frank’s read-only tool without inheriting worker authority', () => {
  const initial = seedWorkspace();
  const s = command(initial, { type: 'review-with-frank', workloadId: initial.workloads[0].id, result: { recommendation: 'expand' } }, finance);
  expect(s.agentJobs[0].status).toBe('review'); expect(s.agentJobs[0].requestedBy).toBe(finance.user);
  expect(s.agentJobs[0].result?.recommendation).toBe('review');
  expect(s.audit.filter(a => a.actor === 'Frank Coster (simulated)').map(a => a.action)).toEqual(['claim-agent-job', 'process-agent-job']);
  expect(s.outcomes).toEqual(initial.outcomes); expect(s.workloads).toEqual(initial.workloads);
  expect(command(s, { type: 'review-with-frank', workloadId: initial.workloads[0].id }, finance)).toBe(s);
  expect(() => command(s, { type: 'claim-agent-job', jobId: s.agentJobs[0].id }, finance)).toThrow(/permission/);
});
