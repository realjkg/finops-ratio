import { AGENT_POLICY } from "../../src/agent-workflows/policy";
// Dedicated, bounded simulation worker. No model or provider credentials are loaded.
import { randomUUID } from "node:crypto";
import { SimulationDatabase } from "../../src/simulation/server/database";
if (
  process.env.RATIO_SIMULATION !== "1" ||
  !["test", "development"].includes(process.env.RATIO_ENV ?? "")
)
  throw new Error(
    "Worker requires an explicitly enabled simulation environment.",
  );
const tenant = process.env.RATIO_WORKER_TENANT;
if (!tenant || !["acme", "northstar"].includes(tenant))
  throw new Error(
    "Select an allowlisted simulation tenant with RATIO_WORKER_TENANT.",
  );
const db = new SimulationDatabase(
  process.env.RATIO_SIMULATION_DB ?? ".ratio-simulation/customer.sqlite",
);
const actor = {
  tenant,
  user: "Ratio review worker (simulated)",
  persona: "technical" as const,
};
let processed = 0;
try {
  // One bounded drain per invocation; an external scheduler can invoke it repeatedly.
  for (let i = 0; i < AGENT_POLICY.maxJobsPerDrain; i++) {
    const state = db.read(tenant);
    const job = state.agentJobs.find(
      (j) =>
        j.attempts < AGENT_POLICY.maxAttempts &&
        (j.status === "queued" ||
          (j.status === "running" &&
            j.lease &&
            Date.parse(j.lease.expiresAt) <= Date.now())),
    );
    if (!job) break;
    try {
      const claimed = db.command(actor, state.revision, randomUUID(), {
        type: "claim-agent-job",
        jobId: job.id,
      });
      const lease = claimed.agentJobs.find((j) => j.id === job.id)!.lease!;
      db.command(actor, claimed.revision, randomUUID(), {
        type: "process-agent-job",
        jobId: job.id,
        leaseToken: lease.token,
      });
      processed++;
    } catch (error) {
      // Conflicting updates are retried by the next scheduled invocation, never blind financial writes.
      if (error instanceof Error && "status" in error && error.status === 409)
        break;
      throw error;
    }
  }
  console.log(JSON.stringify({ mode: "simulation", processed, tenant }));
} finally {
  db.close();
}
