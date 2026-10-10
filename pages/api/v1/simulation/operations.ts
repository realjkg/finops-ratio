import { AGENT_POLICY } from "@/agent-workflows/policy";
import { database } from "@/simulation/server/database";
import { sessionFor, simulationRoute } from "@/simulation/server/http";
import { reviewBasis } from "@/agent-workflows/engine";
export default simulationRoute(["GET"], (req, res) => {
  const session = sessionFor(req);
  const db = database();
  const s = db.read(session.identity.tenant);
  const now = Date.now();
  const jobs = s.agentJobs;
  res
    .status(200)
    .json({
      mode: "simulation",
      databaseReady: db.integrity(),
      revision: s.revision,
      runtime: "deterministic-simulation-v1",
      modelCalls: 0,
      externalActions: 0,
      queue: Object.fromEntries(
        ["queued", "running", "failed", "review", "accepted", "dismissed"].map(
          (status) => [status, jobs.filter((j) => j.status === status).length],
        ),
      ),
      expiredLeases: jobs.filter(
        (j) =>
          j.status === "running" &&
          j.lease &&
          Date.parse(j.lease.expiresAt) <= now,
      ).length,
      staleProposals: jobs
        .filter((j) => j.result && j.basis !== reviewBasis(s, j.workloadId))
        .map((j) => j.id),
      oldestQueuedAgeSeconds: Math.max(
        0,
        ...jobs
          .filter((j) => j.status === "queued")
          .map((j) => Math.floor((now - Date.parse(j.createdAt)) / 1000)),
      ),
      auditEvents: s.audit.length,
      limits: AGENT_POLICY,
    });
});
