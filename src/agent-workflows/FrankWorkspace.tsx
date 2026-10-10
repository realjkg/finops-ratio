import Link from "next/link";
import { useState } from "react";
import { useStore } from "@/store/useStore";
import { simulationRequest } from "@/simulation/client";
import { FRANK, FRANK_PROMPTS, frankGuide, type FrankGuide } from "./frank";
export function FrankWorkspace() {
  const sim = useStore((s) => s.simulation);
  const selected = useStore((s) => s.selectedId);
  if (!sim) return null;
  return <FrankSession key={`${sim.session.csrf}:${selected}`} />;
}
function FrankSession() {
  const sim = useStore((s) => s.simulation)!;
  const selected = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const run = useStore((s) => s.simulationCommand);
  const busy = useStore((s) => s.simulationBusy);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<FrankGuide | null>(null);
  const [asked, setAsked] = useState("");
  const [rationale, setRationale] = useState("");
  const w =
    sim.state.workloads.find((w) => w.id === selected) ??
    sim.state.workloads[0];
  const current = frankGuide(sim.state, sim.session.identity, w.id);
  const latest = [...sim.state.agentJobs]
    .reverse()
    .find((j) => j.workloadId === w.id);
  async function ask(text: string) {
    if (asking || !text.trim()) return;
    setAsking(true);
    setError("");
    try {
      const result = await simulationRequest<FrankGuide>(
        "frank",
        { workloadId: w.id, question: text },
        sim.session.csrf,
      );
      if (
        useStore.getState().simulation?.session.csrf !== sim.session.csrf ||
        useStore.getState().selectedId !== selected
      )
        return;
      setAnswer(result);
      setAsked(text);
      setQuestion("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Frank could not read the saved evidence. Try again.",
      );
    } finally {
      setAsking(false);
    }
  }
  const canApprove =
    sim.session.identity.persona !== "technical" &&
    latest?.requestedBy !== sim.session.identity.user;
  return (
    <section className="space-y-6" aria-label="Frank Coster workspace">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-4">
          <div
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-purple/40 bg-purple/10 font-mono text-sm text-purple"
          >
            FC
          </div>
          <div>
            <p className="text-xs uppercase tracking-widest text-sub">
              Ratio · FinOps agent
            </p>
            <h1 className="mt-1 text-3xl font-semibold">{FRANK.name}</h1>
            <p className="mt-2 text-sm text-sub">{FRANK.role}</p>
          </div>
        </div>
        <span className="rounded-full border border-edge px-3 py-1 text-xs text-sub">
          Simulated · evidence guided
        </span>
      </header>
      <p className="max-w-3xl text-sm leading-relaxed text-sub">
        I’ll help you see what your AI initiative is worth, what’s still
        unproven, and who needs to act next. We’ll work from the evidence and
        keep decisions accountable.
      </p>
      <label className="block text-sm">
        Working initiative
        <select
          className="sim-input mt-2 block w-full sm:max-w-md"
          value={w.id}
          onChange={(e) => select(e.target.value)}
        >
          {sim.state.workloads.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section className="rounded-xl border border-edge bg-deep p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Work through it with Frank</h2>
              <span className="text-xs text-sub">
                Saved evidence · revision {current.revision}
              </span>
            </div>
            <div
              className="mt-5 space-y-4"
              role="log"
              aria-label="Conversation with Frank"
              aria-live="polite"
            >
              {asked && (
                <p className="ml-8 rounded-lg bg-raised p-3 text-sm">{asked}</p>
              )}
              <div className="border-l-2 border-purple pl-4">
                <p className="mb-2 text-xs font-semibold text-purple">
                  Frank Coster
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {answer?.message ?? current.message}
                </p>
                {answer && (
                  <p className="mt-2 text-xs text-sub">
                    Answer based on revision {answer.revision}
                    {answer.revision !== current.revision
                      ? " · Workspace has changed; ask again for an updated answer."
                      : ""}
                  </p>
                )}
              </div>
              {asking && (
                <p className="text-sm text-sub">
                  Frank is reviewing the saved evidence…
                </p>
              )}
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {FRANK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  className="rounded-lg border border-edge p-3 text-left text-xs text-sub hover:bg-raised disabled:opacity-50"
                  disabled={asking}
                  onClick={() => void ask(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <form
              className="mt-5"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(question);
              }}
            >
              <label className="text-xs text-sub">
                Ask Frank
                <textarea
                  className="sim-input mt-2 block w-full"
                  maxLength={2000}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask about the owner, evidence, full cost or decision…"
                />
              </label>
              <button
                className="sim-button mt-3"
                disabled={asking || !question.trim()}
              >
                Ask Frank
              </button>
            </form>
            {error && (
              <p role="alert" className="mt-3 text-sm text-cost">
                {error}
              </p>
            )}
          </section>
          <section className="rounded-xl border border-edge bg-deep p-5 sm:p-6">
            <h2 className="font-semibold">Frank’s review</h2>
            <p className="mt-2 text-sm text-sub">
              Create a saved review of this initiative’s evidence and proposed
              next steps.
            </p>
            <button
              className="sim-button mt-4"
              disabled={busy}
              onClick={() =>
                void run({ type: "review-with-frank", workloadId: w.id })
              }
            >
              {busy ? "Saving review…" : "Review with Frank"}
            </button>
            {latest && (
              <div className="mt-5 space-y-3 border-t border-edge pt-4">
                <p className="text-xs text-sub">
                  Saved review · {latest.status} · {latest.updatedAt}
                </p>
                {latest.result && (
                  <>
                    <p className="text-sm">
                      Suggested decision:{" "}
                      <strong>{latest.result.recommendation}</strong>
                    </p>
                    <ol className="space-y-3">
                      {latest.result.tasks.map((task, i) => (
                        <li key={i} className="text-sm">
                          <span className="mr-2 rounded border border-edge px-2 py-0.5 text-xs capitalize text-sub">
                            {task.role}
                          </span>
                          {task.instruction}
                        </li>
                      ))}
                    </ol>
                    <Link
                      className="inline-block text-sm text-unit underline"
                      href="/outcomes"
                    >
                      Complete the evidence and decision
                    </Link>
                  </>
                )}
                {latest.error && (
                  <p className="text-sm text-shape">
                    {latest.error} Open operational controls below to recover
                    the job.
                  </p>
                )}
                {latest.status === "review" && (
                  <>
                    <label className="block text-sm">
                      Review rationale for Frank
                      <textarea
                        className="sim-input mt-2 block w-full"
                        value={rationale}
                        maxLength={1000}
                        onChange={(e) => setRationale(e.target.value)}
                        placeholder="Explain how you will address these next steps"
                      />
                    </label>
                    <button
                      className="sim-button"
                      disabled={
                        busy || !canApprove || rationale.trim().length < 10
                      }
                      onClick={() =>
                        void run({
                          type: "review-agent-proposal",
                          jobId: latest.id,
                          resolution: "accepted",
                          rationale,
                        })
                      }
                    >
                      Accept Frank’s review
                    </button>
                    <p className="text-xs text-sub">
                      A different Executive or Procurement reviewer accepts this
                      proposal. Acceptance records review; business decisions
                      remain a separate approval.
                    </p>
                  </>
                )}
                {latest.review && (
                  <p className="text-sm text-sub">
                    {latest.review.by}: {latest.review.rationale}
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
        <aside
          className="min-w-0 space-y-5"
          aria-label="Evidence and authority"
        >
          <section className="rounded-xl border border-edge bg-deep p-5">
            <h2 className="font-semibold">The path to a decision</h2>
            <ol className="mt-5 space-y-5">
              {current.steps.map((step, i) => (
                <li key={step.key}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">
                      {i + 1}. {step.title}
                    </h3>
                    <span
                      className={`shrink-0 text-xs ${step.ready ? "text-unit" : "text-shape"}`}
                    >
                      {step.ready ? "Recorded" : "Needs attention"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-sub">
                    {step.detail}
                  </p>
                  <Link
                    className="mt-2 inline-block text-xs text-unit underline"
                    href={step.href}
                    onClick={() =>
                      useStore
                        .getState()
                        .setTab(
                          step.key === "decision" ? "governance" : "outcomes",
                        )
                    }
                  >
                    Open {step.title.toLowerCase()}
                  </Link>
                </li>
              ))}
            </ol>
          </section>
          <section className="rounded-xl border border-edge bg-deep p-5">
            <h2 className="font-semibold">Frank’s authority</h2>
            <p className="mt-3 text-sm leading-relaxed text-sub">
              {current.authority}
            </p>
            <dl className="mt-4 space-y-3 text-xs">
              <div>
                <dt className="text-sub">Scope</dt>
                <dd className="mt-1">
                  {sim.session.identity.tenant} · selected initiative
                </dd>
              </div>
              <div>
                <dt className="text-sub">Tool access</dt>
                <dd className="mt-1">
                  Saved evidence and bounded outcome review
                </dd>
              </div>
              <div>
                <dt className="text-sub">Execution</dt>
                <dd className="mt-1">
                  No cloud actions, external messages or provider credentials
                </dd>
              </div>
            </dl>
            <Link
              href="/workspace"
              className="mt-4 inline-block text-xs text-unit underline"
            >
              View shared audit history
            </Link>
          </section>
        </aside>
      </div>
    </section>
  );
}
