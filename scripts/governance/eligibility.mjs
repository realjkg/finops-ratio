// Merge-eligibility decision (governance track). Pure: no I/O. The workflow
// gathers PR state from the GitHub API and calls decideEligibility(); auto-merge
// is enabled ONLY when it returns eligible:true, otherwise it is disabled and
// the reasons are written to the job summary.

export const CI_CHECK_NAME = 'Lint · Typecheck · Test · Build';
export const GITHUB_ACTIONS_APP_ID = 15368;

export const DEFAULT_CONFIG = Object.freeze({
  // CI must be THIS check run: right name, created by the GitHub Actions app,
  // from a run of .github/workflows/ci.yml. A same-named check from another
  // workflow, another app, or a commit status never satisfies it.
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
  // The governance workflow's own eligibility jobs are excluded from "every
  // other check" (they are in progress while deciding). Hiding a check by name
  // only ever hides the excluder's own check: CI and review are required
  // separately, so this cannot mask a genuine gate.
  selfCheckPrefixes: Object.freeze(['Governance · merge eligibility', 'Governance · eligibility targets']),
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

  const isSelf = (r) => config.selfCheckPrefixes.some((p) => r.name.startsWith(p));
  const runs = latestCheckRuns(state?.checkRuns).filter((r) => !isSelf(r));

  // CI: the genuine ci.yml check run must exist and succeed.
  const ci = config.ciCheck;
  const genuineCi = runs.find((r) => r.name === ci.name && r.appId === ci.appId && r.workflowPath === ci.workflowPath);
  if (!genuineCi) {
    reasons.push(`Required check "${ci.name}" from ${ci.workflowPath} (app ${ci.appId}) has not run on the head SHA.`);
  }

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
