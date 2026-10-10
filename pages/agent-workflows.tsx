import { FrankWorkspace } from "@/agent-workflows/FrankWorkspace";
import Link from "next/link";
import { useState } from "react";
import { useStore } from "@/store/useStore";
export default function AgentWorkflows() {
  const sim = useStore((s) => s.simulation);
  const run = useStore((s) => s.simulationCommand);
  const busy = useStore((s) => s.simulationBusy);
  const selected = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const [rationale, setRationale] = useState("");
  if (!sim)
    return (
      <div className="p-8">
        <h1 className="text-2xl">Agent workflows</h1>
        <Link href="/simulation" className="mt-4 block text-unit underline">
          Choose a simulated identity
        </Link>
      </div>
    );
  const { state, session } = sim;
  const tech = session.identity.persona === "technical";
  const jobs = state.agentJobs;
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <FrankWorkspace />
        <details className="rounded-xl border border-edge p-5">
          <summary className="cursor-pointer text-sm font-semibold">
            Operational controls
          </summary>
          <div className="mt-5 space-y-6">
            <header>
              <h1 className="text-2xl font-semibold">Agent workflows</h1>
              <p className="mt-2 text-sm text-sub">
                Persistent outcome reviews · {session.identity.tenant} ·
                simulated data
              </p>
              <p className="mt-3 text-sm text-sub">
                The embedded review engine identifies evidence gaps and routes
                work to the right role. Acceptance records your review; record
                financial decisions separately in Initiative outcomes. No cloud
                actions or external messages execute here.
              </p>
            </header>
            <section className="rounded border border-edge p-5">
              <label className="block text-sm">
                Review initiative
                <select
                  className="sim-input mt-2 block max-w-full"
                  value={selected}
                  onChange={(e) => select(e.target.value)}
                >
                  {state.workloads.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="sim-button mt-4"
                disabled={busy}
                onClick={() =>
                  void run({ type: "queue-agent-review", workloadId: selected })
                }
              >
                Queue outcome review
              </button>
              <p className="mt-2 text-xs text-sub">
                Identical evidence reuses its existing job. Each job permits
                three processing attempts.
              </p>
            </section>
            <section className="rounded border border-edge p-5">
              <h2 className="text-lg font-semibold">Operational status</h2>
              <div className="mt-3 flex flex-wrap gap-5 text-sm">
                {["queued", "running", "failed", "review"].map((status) => (
                  <span key={status}>
                    {status}: {jobs.filter((j) => j.status === status).length}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-sub">
                Processing leases last 60 seconds. A Technical identity can
                reclaim expired work. Refresh the saved workspace after a worker
                run. Runtime: deterministic simulation; model calls: 0; external
                actions: 0.
              </p>
              <Link
                href="/api/v1/simulation/operations"
                className="mt-3 inline-block text-unit underline"
              >
                Authenticated operational diagnostics
              </Link>
            </section>
            <label className="block text-sm">
              Proposal review rationale
              <textarea
                className="sim-input mt-2 block w-full"
                maxLength={1000}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Explain your acceptance or dismissal"
              />
            </label>
            <section className="space-y-4" aria-label="Review jobs">
              {jobs.length === 0 && (
                <p className="text-sub">No agent reviews yet.</p>
              )}
              {[...jobs].reverse().map((j) => {
                const expired =
                  !!j.lease && Date.parse(j.lease.expiresAt) <= Date.now();
                const ownsLease =
                  j.lease?.owner === session.identity.user && !expired;
                const reviewAllowed =
                  !tech &&
                  j.requestedBy !== session.identity.user &&
                  rationale.trim().length >= 10;
                return (
                  <article
                    key={j.id}
                    className="rounded border border-edge bg-deep p-5"
                  >
                    <h2 className="font-semibold">
                      {state.workloads.find((w) => w.id === j.workloadId)?.name}
                    </h2>
                    <p className="mt-2 text-sm">
                      Status: {j.status} · Attempt {j.attempts}/3
                    </p>
                    <p className="mt-2 break-all text-xs text-sub">
                      {j.id} · requested by {j.requestedBy} · {j.updatedAt}
                    </p>
                    {j.lease && (
                      <p className="mt-2 text-xs text-sub">
                        Lease: {j.lease.owner} until {j.lease.expiresAt}
                      </p>
                    )}
                    {j.error && (
                      <p className="mt-3 text-sm text-shape">{j.error}</p>
                    )}
                    {j.result && (
                      <>
                        <p className="mt-3 text-sm">
                          Suggested decision: {j.result.recommendation} ·
                          Measured value / full cost:{" "}
                          {j.result.measuredRatio === null
                            ? "awaiting evidence"
                            : `${j.result.measuredRatio.toFixed(2)}×`}
                        </p>
                        <ol className="mt-3 space-y-2 text-sm text-sub">
                          {j.result.tasks.map((t, i) => (
                            <li key={i}>
                              <strong className="capitalize">{t.role}</strong>:{" "}
                              {t.instruction}
                            </li>
                          ))}
                        </ol>
                        <p className="mt-3 text-xs text-sub">
                          Acceptance checks the current evidence. Changed
                          evidence requires a new review.
                        </p>
                      </>
                    )}
                    {j.review && (
                      <p className="mt-3 text-sm text-sub">
                        Reviewed by {j.review.by}: {j.review.rationale}
                      </p>
                    )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      {(j.status === "queued" ||
                        (j.status === "running" && expired)) && (
                        <button
                          className="sim-button"
                          disabled={busy || !tech || j.attempts >= 3}
                          onClick={() =>
                            void run({ type: "claim-agent-job", jobId: j.id })
                          }
                        >
                          Claim processing lease
                        </button>
                      )}
                      {j.status === "running" && (
                        <>
                          <button
                            className="sim-button"
                            disabled={busy || !tech || !ownsLease}
                            onClick={() =>
                              void run({
                                type: "process-agent-job",
                                jobId: j.id,
                                leaseToken: j.lease?.token,
                              })
                            }
                          >
                            Process review
                          </button>
                          <button
                            className="sim-button"
                            disabled={busy || !tech || !ownsLease}
                            onClick={() =>
                              void run({
                                type: "fail-agent-job",
                                jobId: j.id,
                                leaseToken: j.lease?.token,
                              })
                            }
                          >
                            Simulate interruption
                          </button>
                        </>
                      )}
                      {j.status === "failed" && (
                        <button
                          className="sim-button"
                          disabled={busy || !tech || j.attempts >= 3}
                          onClick={() =>
                            void run({ type: "retry-agent-job", jobId: j.id })
                          }
                        >
                          Retry review
                        </button>
                      )}
                      {j.status === "review" && (
                        <button
                          className="sim-button"
                          disabled={busy || !reviewAllowed}
                          onClick={() =>
                            void run({
                              type: "review-agent-proposal",
                              jobId: j.id,
                              resolution: "accepted",
                              rationale,
                            })
                          }
                        >
                          Accept proposal review
                        </button>
                      )}
                      {["queued", "running", "failed", "review"].includes(
                        j.status,
                      ) && (
                        <button
                          className="sim-button"
                          disabled={busy || !reviewAllowed}
                          onClick={() =>
                            void run({
                              type: "review-agent-proposal",
                              jobId: j.id,
                              resolution: "dismissed",
                              rationale,
                            })
                          }
                        >
                          Dismiss review
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          </div>
        </details>
        <nav className="flex flex-wrap gap-5 text-sm text-unit">
          <Link href="/outcomes">Initiative outcomes</Link>
          <Link href="/workspace">Cost tracking workspace</Link>
          <Link href="/reports">Reports</Link>
        </nav>
      </div>
    </div>
  );
}
