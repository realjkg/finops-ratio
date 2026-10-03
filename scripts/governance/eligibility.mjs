// Merge-eligibility decision (governance track). Pure: no I/O. The workflow
// gathers PR state from the GitHub API and calls decideEligibility(); auto-merge
// is enabled ONLY when it returns eligible:true, otherwise it is disabled and
// the reasons are written to the job summary.

export const DEFAULT_CONFIG = Object.freeze({
  // Check runs that must be present AND successful on the head SHA. Without an
  // explicit list, "every check passed" would be vacuously true on a PR whose
  // CI has not been scheduled yet.
  requiredChecks: ['Lint · Typecheck · Test · Build', 'Governance · risk classification'],
  // Independent agent review currently available (proxy until an in-CI agent
  // reviewer exists).
  reviewerCheckName: 'copilot-pull-request-reviewer',
  // This job's own check run is excluded from "every other check".
  selfCheckNames: ['Governance · merge eligibility'],
  baseBranch: 'main',
});

/** Keep only the most recent run (highest id) for each check name. */
export function latestCheckRuns(checkRuns) {
  const byName = new Map();
  for (const run of checkRuns ?? []) {
    const prev = byName.get(run.name);
    if (!prev || run.id > prev.id) byName.set(run.name, run);
  }
  return [...byName.values()];
}

/**
 * @param {{
 *   pr: { draft: boolean, baseRef: string, headSha: string, labels: string[] },
 *   freshRisk?: 'low' | 'restricted',
 *   checkRuns: Array<{ id: number, name: string, status: string, conclusion: string | null }>,
 *   statuses?: Array<{ context: string, state: string }>,
 *   unresolvedThreads: number | null,
 * }} state
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function decideEligibility(state, config = DEFAULT_CONFIG) {
  const reasons = [];
  const pr = state?.pr ?? {};
  const labels = new Set(pr.labels ?? []);

  if (!labels.has('risk:low')) reasons.push('PR is not labelled risk:low.');
  if (labels.has('risk:restricted')) reasons.push('PR carries risk:restricted.');
  if (state?.freshRisk !== 'low') {
    reasons.push(`Fresh classification of the current file list is "${state?.freshRisk ?? 'unknown'}", not low.`);
  }
  if (pr.draft !== false) reasons.push('PR is a draft (or draft state unknown).');
  if (pr.baseRef !== config.baseBranch) {
    reasons.push(`Base branch is "${pr.baseRef ?? 'unknown'}", not ${config.baseBranch}.`);
  }

  const self = new Set(config.selfCheckNames);
  const runs = latestCheckRuns(state?.checkRuns).filter((r) => !self.has(r.name));
  const byName = new Map(runs.map((r) => [r.name, r]));

  // A required check may be reported as a check run or as a commit status
  // (the classification job also posts a status on the head SHA so branch
  // protection can see it). The independent reviewer must be a check run.
  const statusNames = new Set((state?.statuses ?? []).map((s) => s.context));
  for (const name of config.requiredChecks) {
    if (!byName.has(name) && !statusNames.has(name)) {
      reasons.push(`Required check "${name}" has not run on the head SHA.`);
    }
  }
  if (!byName.has(config.reviewerCheckName)) {
    reasons.push(`Required check "${config.reviewerCheckName}" has not run on the head SHA.`);
  }
  for (const r of runs) {
    if (r.status !== 'completed') reasons.push(`Check "${r.name}" is ${r.status}.`);
    else if (r.conclusion !== 'success') reasons.push(`Check "${r.name}" concluded ${r.conclusion}.`);
  }
  for (const s of state?.statuses ?? []) {
    if (s.state !== 'success') reasons.push(`Commit status "${s.context}" is ${s.state}.`);
  }

  const t = state?.unresolvedThreads;
  if (typeof t !== 'number' || !Number.isFinite(t)) reasons.push('Unresolved review thread count is unknown.');
  else if (t > 0) reasons.push(`${t} unresolved review thread(s).`);

  return { eligible: reasons.length === 0, reasons };
}
