import { AGENT_POLICY } from "./policy";
import { createHash, randomUUID } from "node:crypto";
import { evaluateOutcome, outcomeBasis } from "@/outcomes/model";
import type { Command, SimIdentity, Workspace } from "@/simulation/types";
import type { AgentJob } from "./types";
export const AGENT_COMMANDS = [
  "queue-agent-review",
  "claim-agent-job",
  "process-agent-job",
  "fail-agent-job",
  "retry-agent-job",
  "review-agent-proposal",
];
export class AgentWorkflowError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function check(ok: unknown, message: string, status = 409): asserts ok {
  if (!ok) throw new AgentWorkflowError(status, message);
}
export function reviewBasis(s: Workspace, workloadId: string): string {
  const w = s.workloads.find((w) => w.id === workloadId);
  check(w && s.outcomes[workloadId], "Workload not found.", 404);
  return createHash("sha256")
    .update(outcomeBasis(s.outcomes[workloadId], s.ledger, w.governance))
    .digest("hex");
}
export function executeAgentCommand(
  s: Workspace,
  actor: SimIdentity,
  c: Command,
  now: string,
): boolean {
  const jobs = s.agentJobs;
  if (c.type === "queue-agent-review") {
    check(typeof c.workloadId === "string", "Workload required.", 400);
    const basis = reviewBasis(s, c.workloadId);
    // One review per input snapshot; queued, completed and failed replays cannot multiply work.
    if (jobs.some((j) => j.workloadId === c.workloadId && j.basis === basis))
      return false;
    check(
      jobs.length < AGENT_POLICY.maxJobsPerTenant,
      "Simulation review history limit reached. Export this workspace before starting another simulation.",
    );
    jobs.push({
      id: randomUUID(),
      workloadId: c.workloadId,
      requestedBy: actor.user,
      createdAt: now,
      updatedAt: now,
      basis,
      status: "queued",
      attempts: 0,
    });
    return true;
  }
  check(typeof c.jobId === "string", "Job required.", 400);
  const j = jobs.find((j) => j.id === c.jobId);
  check(j, "Review job not found in this tenant.", 404);
  if (c.type === "claim-agent-job") {
    check(
      j.status === "queued" ||
        (j.status === "running" && j.lease && j.lease.expiresAt <= now),
      "Job is not available for processing.",
    );
    check(
      j.attempts < AGENT_POLICY.maxAttempts,
      "Attempt limit reached. Dismiss this job and change the evidence before a new review.",
    );
    j.attempts++;
    j.status = "running";
    j.error = undefined;
    j.lease = {
      owner: actor.user,
      token: randomUUID(),
      expiresAt: new Date(
        Date.parse(now) + AGENT_POLICY.leaseSeconds * 1000,
      ).toISOString(),
    };
  } else if (c.type === "retry-agent-job") {
    check(
      j.status === "failed" && j.attempts < AGENT_POLICY.maxAttempts,
      "Only failed jobs below the attempt limit can retry.",
    );
    j.status = "queued";
    j.lease = undefined;
  } else if (c.type === "process-agent-job" || c.type === "fail-agent-job") {
    check(
      j.status === "running" &&
        j.lease?.owner === actor.user &&
        j.lease.token === c.leaseToken &&
        j.lease.expiresAt > now,
      "A current processing lease is required.",
    );
    // A controlled failure probe exercises recovery without accepting arbitrary errors or agent output.
    if (c.type === "fail-agent-job") {
      j.status = "failed";
      j.error = "Simulated processor interruption. Review and retry.";
    } else if (j.basis !== reviewBasis(s, j.workloadId)) {
      j.status = "failed";
      j.error =
        "Evidence changed during processing. Queue a review of the current evidence.";
    } else {
      const o = s.outcomes[j.workloadId];
      const w = s.workloads.find((w) => w.id === j.workloadId)!;
      const result = evaluateOutcome(o, s.ledger);
      const governanceReady =
        w.governance.policy_check &&
        w.governance.ethics_review &&
        w.governance.cost_approval &&
        w.governance.scale_authorized;
      const tasks: NonNullable<AgentJob["result"]>["tasks"] =
        result.blockers.map((instruction) => ({
          role:
            instruction.includes("review") || instruction.includes("financial")
              ? "procurement"
              : "technical",
          instruction,
        }));
      if (!governanceReady)
        tasks.push({
          role: "executive",
          instruction:
            "Complete sequential governance approval before expansion.",
        });
      tasks.push({
        role: "executive",
        instruction:
          "Review outcome evidence and record a business decision in Initiative outcomes.",
      });
      j.result = {
        engine: "deterministic-simulation-v1",
        recommendation:
          result.recommendation === "expand" && !governanceReady
            ? "review"
            : result.recommendation,
        measuredRatio: result.measuredRatio,
        governanceReady,
        tasks,
      };
      j.status = "review";
    }
    j.lease = undefined;
  } else if (c.type === "review-agent-proposal") {
    check(
      c.resolution === "accepted" || c.resolution === "dismissed",
      "Choose acceptance or dismissal.",
      400,
    );
    check(
      j.status === "review" ||
        (c.resolution === "dismissed" &&
          ["queued", "failed", "running"].includes(j.status)),
      "Job is not awaiting review.",
    );
    check(
      j.requestedBy !== actor.user,
      "A different person must review the agent proposal.",
      403,
    );
    if (c.resolution === "accepted")
      check(
        j.basis === reviewBasis(s, j.workloadId),
        "Proposal is stale. Queue a review of the current evidence.",
      );
    check(
      typeof c.rationale === "string" &&
        c.rationale.trim().length >= 10 &&
        c.rationale.length <= 1000,
      "Provide a review rationale of 10–1000 characters.",
      400,
    );
    j.status = c.resolution;
    j.review = { by: actor.user, at: now, rationale: c.rationale.trim() };
    j.lease = undefined;
    // Acceptance only records a human review. Existing domain commands retain exclusive write authority.
  }
  j.updatedAt = now;
  return true;
}

// A bounded read-only agent tool: evaluate one initiative using server-owned inputs.
export function reviewWithFrank(s: Workspace, actor: SimIdentity, workloadId: unknown, now: string): boolean {
  check(typeof workloadId === 'string', 'Choose an initiative.', 400);
  const basis = reviewBasis(s, workloadId);
  let changed = executeAgentCommand(s, actor, { type: 'queue-agent-review', workloadId }, now);
  const job = s.agentJobs.find(j => j.workloadId === workloadId && j.basis === basis)!;
  if (job.status !== 'queued') return changed;
  const worker: SimIdentity = { ...actor, user: 'Frank Coster (simulated)', persona: 'technical' };
  executeAgentCommand(s, worker, { type: 'claim-agent-job', jobId: job.id }, now);
  executeAgentCommand(s, worker, { type: 'process-agent-job', jobId: job.id, leaseToken: job.lease!.token }, now);
  for (const action of ['claim-agent-job', 'process-agent-job']) s.audit.push({ id: randomUUID(), at: now, actor: worker.user, persona: worker.persona, action, target: job.id });
  changed = true;
  return changed;
}
