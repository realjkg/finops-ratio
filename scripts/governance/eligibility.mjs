// Merge-eligibility decision (governance track). Pure: no I/O. The workflow
// gathers PR state from the GitHub API and calls decideEligibility(); auto-merge
// is enabled ONLY when it returns eligible:true, otherwise it is disabled and
// the reasons are written to the job summary.

export const CI_CHECK_NAME = 'Lint · Typecheck · Test · Build';
export const GITHUB_ACTIONS_APP_ID = 15368;

export const DEFAULT_CONFIG = Object.freeze({
  // CI is verified through the Actions jobs API: the job named CI_CHECK_NAME in
  // the latest attempt of the newest pull_request run of ci.yml for the head
  // SHA must have succeeded, and EVERY check run on the head carrying that name
  // must be one of that attempt's job ids (an Actions job id is its check run
  // id). Anything else carrying the name is treated as a spoof. Commit
  // statuses never satisfy CI. appId is used for branch protection.
  ciCheck: Object.freeze({
    name: CI_CHECK_NAME,
    appId: GITHUB_ACTIONS_APP_ID,
    workflowPath: '.github/workflows/ci.yml',
  }),
  // Independent agent review currently available: a submitted PR review by the
  // Copilot reviewer bot on the exact head SHA (proxy until an in-CI agent
  // reviewer exists). Check runs/statuses never satisfy it.
  reviewer: Object.freeze({
    login: 'copilot-pull-request-reviewer[bot]',
    userType: 'Bot',
    states: Object.freeze(['COMMENTED', 'APPROVED']),
  }),
  // No self-exclusion: the governance jobs run on base-context events and
  // their check runs are not attached to the PR head SHA.
  baseBranch: 'main',
  allowedAuthorAssociations: Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']),
});

const runKey = (r) => `${r.name}\0${r.appId ?? ''}\0${r.workflowPath ?? ''}`;

/** Keep only the most recent run (highest id) per (name, app, workflow path). */
export function latestCheckRuns(checkRuns) {
  const byKey = new Map();
  for (const run of checkRuns ?? []) {
    const k = runKey(run);
    const prev = byKey.get(k);
    if (!prev || run.id > prev.id) byKey.set(k, run);
  }
  return [...byKey.values()];
}

/** Why a PR from this author/repo can never be auto-merged, or null. */
export function outsiderReason(pr, config = DEFAULT_CONFIG) {
  const reasons = [];
  if (!pr.headRepo || pr.headRepo !== pr.baseRepo) {
    reasons.push(`Fork PR (head repo ${pr.headRepo ?? 'unknown'} ≠ base repo ${pr.baseRepo ?? 'unknown'}).`);
  }
  if (!config.allowedAuthorAssociations.includes(pr.authorAssociation)) {
    reasons.push(`PR author association is ${pr.authorAssociation ?? 'unknown'} (must be ${config.allowedAuthorAssociations.join('/')}).`);
  }
  return reasons.length ? reasons.join(' ') : null;
}

/**
 * @param {{
 *   pr: { draft: boolean, baseRef: string, headSha: string, labels: string[],
 *         headRepo: string|null, baseRepo: string, authorAssociation: string },
 *   freshRisk?: 'low' | 'restricted',
 *   checkRuns: Array<{ id: number, name: string, status: string, conclusion: string|null,
 *                      appId?: number, workflowPath?: string }>,
 *   statuses?: Array<{ context: string, state: string }>,
 *   reviews?: Array<{ login: string, userType: string, commitId: string, state: string }>,
 *   ciJobs: Array<{ id: number|null, name: string, status: string, conclusion: string|null, runId?: number }> | null,
 *   sharedHeadWith: number[] | null,
 *   unresolvedThreads: number | null,
 * }} state
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function decideEligibility(state, config = DEFAULT_CONFIG) {
  const reasons = [];
  const pr = state?.pr ?? {};
  const labels = new Set(pr.labels ?? []);

  const outsider = outsiderReason(pr, config);
  if (outsider) reasons.push(`Never auto-merge eligible: ${outsider}`);

  if (!labels.has('risk:low')) reasons.push('PR is not labelled risk:low.');
  if (labels.has('risk:restricted')) reasons.push('PR carries risk:restricted.');
  if (state?.freshRisk !== 'low') {
    reasons.push(`Fresh classification of the current file list is "${state?.freshRisk ?? 'unknown'}", not low.`);
  }
  if (pr.draft !== false) reasons.push('PR is a draft (or draft state unknown).');
  if (pr.baseRef !== config.baseBranch) {
    reasons.push(`Base branch is "${pr.baseRef ?? 'unknown'}", not ${config.baseBranch}.`);
  }

  const ci = config.ciCheck;
  const all = state?.checkRuns ?? [];
  // CI-named runs are never deduplicated: an impostor must not mask a failure.
  const ciRuns = all.filter((r) => r.name === ci.name);
  const runs = [...ciRuns, ...latestCheckRuns(all.filter((r) => r.name !== ci.name))];

  const jobs = state?.ciJobs;
  if (!Array.isArray(jobs)) {
    reasons.push(`No ${ci.workflowPath} pull_request run found for the head SHA; CI "${ci.name}" is unverified.`);
  } else {
    // ciJobs is the union over EVERY qualifying run (each on its latest
    // attempt). Every CI-named job must have succeeded; a qualifying run with no
    // CI job is represented by a placeholder with status "missing".
    const ciNamed = jobs.filter((j) => j.name === ci.name);
    if (!ciNamed.length) {
      reasons.push(`Job "${ci.name}" not found in the latest attempt of ${ci.workflowPath}.`);
    }
    for (const job of ciNamed) {
      if (job.status === 'missing') {
        reasons.push(`Job "${ci.name}" not found in the latest attempt of ${ci.workflowPath} run ${job.runId}.`);
      } else if (job.status !== 'completed' || job.conclusion !== 'success') {
        reasons.push(`CI job "${ci.name}" (${ci.workflowPath}, id ${job.id}) is ${job.status}/${job.conclusion}.`);
      } else if (!ciRuns.some((r) => r.id === job.id)) {
        reasons.push(`CI job "${ci.name}" (id ${job.id}) has no check run on the head SHA.`);
      }
    }
    const jobIds = new Set(jobs.map((j) => j.id));
    for (const r of ciRuns) {
      if (!jobIds.has(r.id)) {
        reasons.push(`Check run "${ci.name}" id ${r.id} is not a job of ${ci.workflowPath}'s latest attempt; treated as a spoof.`);
      }
    }
  }

  // Another open PR with the same head SHA can trigger CI runs that list this
  // PR too; refuse to decide for a shared head.
  const shared = state?.sharedHeadWith;
  if (!Array.isArray(shared)) reasons.push('Whether another open PR shares the head SHA is unknown.');
  else for (const n of shared) reasons.push(`head SHA shared with PR #${n}`);

  // Every other check run (including any same-named impostor) must succeed.
  for (const r of runs) {
    const label = r.workflowPath ? `${r.name}" (${r.workflowPath})` : `${r.name}"`;
    if (r.status !== 'completed') reasons.push(`Check "${label} is ${r.status}.`);
    else if (r.conclusion !== 'success') reasons.push(`Check "${label} concluded ${r.conclusion}.`);
  }
  for (const s of state?.statuses ?? []) {
    if (s.state !== 'success') reasons.push(`Commit status "${s.context}" is ${s.state}.`);
  }

  // Independent review on the exact head SHA.
  const rv = config.reviewer;
  const reviewed = (state?.reviews ?? []).some(
    (r) => r.login === rv.login && r.userType === rv.userType && r.commitId === pr.headSha && rv.states.includes(r.state),
  );
  if (!reviewed) {
    reasons.push(`No submitted review by ${rv.login} on the head SHA ${String(pr.headSha ?? '').slice(0, 7)} (a fresh review is required after each push).`);
  }

  const t = state?.unresolvedThreads;
  if (typeof t !== 'number' || !Number.isFinite(t)) reasons.push('Unresolved review thread count is unknown.');
  else if (t > 0) reasons.push(`${t} unresolved review thread(s).`);

  return { eligible: reasons.length === 0, reasons };
}
