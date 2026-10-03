// Merge-eligibility decision (governance track). Pure: no I/O. The workflow
// gathers PR state from the GitHub API and calls decideEligibility(); auto-merge
// is enabled ONLY when it returns eligible:true, otherwise it is disabled and
// the reasons are written to the job summary.

export const CI_CHECK_NAME = 'Lint · Typecheck · Test · Build';
/** Commit status posted by the eligibility job; required by branch protection. */
export const ELIGIBILITY_CONTEXT = 'Governance · merge eligibility';
/**
 * Sticky revocation marker: a failure status the eligibility job posts on a SHA
 * once a valid revoke for it is seen. Statuses cannot be deleted, so deleting or
 * editing the revoke comment later cannot revive the approval. Only statuses
 * created by the GitHub Actions bot are honoured.
 */
export const REVOKED_CONTEXT = 'Governance · exception revoked';
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
/**
 * Exception path for restricted PRs: an unedited, non-bot PR comment whose
 * trimmed body is exactly `/exception-approve <40-hex head SHA>` (or
 * `/exception-revoke <sha>`) by an admin/maintain user.
 */
export const EXCEPTION_COMMAND = /^\/exception-(approve|revoke) ([0-9a-fA-F]{40})$/;
const APPROVER_ROLES = new Set(['admin', 'maintain']);
const STATUS_DESCRIPTION_MAX = 140;
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
  // Our own governance workflow's check runs DO appear on the PR head SHA:
  // pull_request_target job runs attach to it (PR #47). A run is "ours" only if
  // ALL hold: app = GitHub Actions, workflow path = governance.yml, event =
  // pull_request_target (`pull_request` suites also attach to the PR head,
  // as CI's do, but they and `workflow_dispatch` runs execute PR/ref-controlled
  // code, so they are never trusted as ours),
  // and the workflow run's head repository = the PR's base repository.
  // Of ours:
  //  - eligibility targets / merge eligibility (#n) are this decision's own
  //    jobs (possibly still in progress): never inputs;
  //  - revocations is issue_comment-only and is excluded ONLY when skipped;
  //  - risk classification IS an input and must be present and
  //    completed+success; a cancelled one is ignored only when a newer own
  //    classify run exists (cancel-in-progress supersession).
  // Same-named runs that are not ours stay ordinary checks.
  ownWorkflow: Object.freeze({
    appId: GITHUB_ACTIONS_APP_ID,
    workflowPath: '.github/workflows/governance.yml',
    events: Object.freeze(['pull_request_target']),
    classifyName: 'Governance · risk classification',
    nonInputNames: Object.freeze(['Governance · eligibility targets']),
    skippedOnlyNames: Object.freeze(['Governance · revocations']),
    nonInputPrefixes: Object.freeze(['Governance · merge eligibility (#']),
  }),
  baseBranch: 'main',
  allowedAuthorAssociations: Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']),
});

/** A check run produced by OUR governance workflow (verified fields, never the name alone). */
export function isOwnGovernanceRun(run, pr, config = DEFAULT_CONFIG) {
  const own = config.ownWorkflow;
  return run.appId === own.appId
    && run.workflowPath === own.workflowPath
    && own.events.includes(run.workflowEvent)
    && typeof pr?.baseRepo === 'string'
    && run.workflowHeadRepo === pr.baseRepo;
}

/**
 * Could this check run be one of ours? GitHub Actions app AND one of our
 * governance job names. Only such runs can ever be excluded or count as our
 * classification, so only their suites are worth resolving (API budget).
 */
export function isGovernanceCandidateRun(run, config = DEFAULT_CONFIG) {
  const own = config.ownWorkflow;
  const name = String(run?.name ?? '');
  return run?.appId === own.appId
    && (name === own.classifyName
      || own.nonInputNames.includes(name)
      || own.skippedOnlyNames.includes(name)
      || own.nonInputPrefixes.some((p) => name.startsWith(p)));
}

/** Our own governance runs that are not inputs to the eligibility decision. */
function isOwnNonInputRun(run, pr, config, all) {
  const own = config.ownWorkflow;
  if (!isOwnGovernanceRun(run, pr, config)) return false;
  if (own.nonInputNames.includes(run.name) || own.nonInputPrefixes.some((p) => run.name.startsWith(p))) return true;
  if (own.skippedOnlyNames.includes(run.name)) return run.status === 'completed' && run.conclusion === 'skipped';
  if (run.name === own.classifyName && run.status === 'completed' && run.conclusion === 'cancelled') {
    // Superseded by a newer classify run of ours (cancel-in-progress).
    return all.some((o) => o !== run && o.name === own.classifyName && o.id > run.id && isOwnGovernanceRun(o, pr, config));
  }
  return false;
}

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
  const tagged = collectReasons(state, config);
  return { eligible: tagged.length === 0, reasons: tagged.map((r) => r.text) };
}

/**
 * All blocking reasons, each tagged `risk: true` when it is about the risk
 * classification (the only kind an approved exception may override).
 */
function collectReasons(state, config) {
  const tagged = [];
  const reasons = { push: (text) => tagged.push({ risk: false, text }) };
  const riskReason = (text) => tagged.push({ risk: true, text });
  const pr = state?.pr ?? {};
  const labels = new Set(pr.labels ?? []);

  const outsider = outsiderReason(pr, config);
  if (outsider) reasons.push(`Never auto-merge eligible: ${outsider}`);

  if (!labels.has('risk:low')) riskReason('PR is not labelled risk:low.');
  if (labels.has('risk:restricted')) riskReason('PR carries risk:restricted.');
  if (state?.freshRisk !== 'low') {
    riskReason(`Fresh classification of the current file list is "${state?.freshRisk ?? 'unknown'}", not low.`);
  }
  if (pr.draft !== false) reasons.push('PR is a draft (or draft state unknown).');
  if (pr.baseRef !== config.baseBranch) {
    reasons.push(`Base branch is "${pr.baseRef ?? 'unknown'}", not ${config.baseBranch}.`);
  }

  const ci = config.ciCheck;
  const all = state?.checkRuns ?? [];
  // Check runs are never collapsed: listForRef(filter=latest) already returns
  // the latest run per suite, and any non-success (in any suite) blocks.
  const ciRuns = all.filter((r) => r.name === ci.name);
  const runs = all.filter((r) => !isOwnNonInputRun(r, pr, config, all));
  // The classification this decision relies on must exist as OUR run on the head.
  const ownClassify = config.ownWorkflow.classifyName;
  if (!all.some((r) => r.name === ownClassify && isOwnGovernanceRun(r, pr, config))) {
    reasons.push(`No "${ownClassify}" check run from ${config.ownWorkflow.workflowPath} (pull_request_target) on the head SHA.`);
  }

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
    // Our own eligibility status is an OUTPUT of this decision, not an input.
    // The revocation marker is handled by the exception logic (Actions bot only),
    // so a forged one cannot block a PR through this generic rule either.
    if (s.context === ELIGIBILITY_CONTEXT || s.context === REVOKED_CONTEXT) continue;
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

  return tagged;
}

const roleOf = (r) => (r ? (APPROVER_ROLES.has(r.role_name) ? r.role_name : r.permission === 'admin' ? 'admin' : r.role_name ?? r.permission) : undefined);

/** True when a getCollaboratorPermissionLevel record grants admin or maintain. */
export const isApproverRole = (record) => APPROVER_ROLES.has(roleOf(record));

/**
 * Parse an exception command from the FIRST line of a comment (trimmed); null
 * unless that line matches exactly. Later lines are free text (evidence link).
 */
export function parseExceptionCommand(body) {
  const first = String(body ?? '').trim().split(/\r?\n/)[0].trim();
  const m = EXCEPTION_COMMAND.exec(first);
  return m ? { action: m[1], sha: m[2].toLowerCase() } : null;
}

/**
 * SHA-bound exception approval for a restricted PR.
 *
 * Commands are read from the first line of non-bot comments by admin/maintain
 * users (`/exception-approve <sha>` / `/exception-revoke <sha>`).
 * - Approval: an UNEDITED approve naming the PR's current head SHA.
 * - Revocations (reported for sticky recording, any SHA they name):
 *   a revoke command; an EDITED approve naming the head; and the original body
 *   of a command comment that the triggering event edited or deleted.
 * - Any revocation for the head, or a sticky revocation status on the head
 *   (`revokedStatuses`, Actions bot only), refuses approval permanently.
 * No timestamps are compared: an approval binds to the commit SHA it names.
 * @param {{ comments: Array<{ id: number, body: string, user?: { login: string, type?: string },
 *           created_at?: string, updated_at?: string }>,
 *           roles: Record<string, { permission?: string, role_name?: string }>,
 *           headSha: string,
 *           revokedStatuses?: Array<{ description?: string }>,
 *           eventComment?: { id: number, body: string, user?: { login: string, type?: string } } }} input
 */
export function evaluateExceptionApproval({ comments, roles, headSha, revokedStatuses = [], eventComment }) {
  const head = String(headSha ?? '').toLowerCase();
  const short = head.slice(0, 7);
  const command = `/exception-approve ${head || '<head-sha>'}`;
  const authorized = (c) => c?.user?.type !== 'Bot' && APPROVER_ROLES.has(roleOf(roles?.[c?.user?.login]));

  const revocations = [];
  const seen = new Set();
  const revoke = (sha, login, commentId, why) => {
    const k = `${sha}\0${commentId}`;
    if (seen.has(k)) return;
    seen.add(k);
    revocations.push({ sha, login, commentId, why });
  };
  const approvals = [];
  for (const c of [...(comments ?? [])].sort((a, b) => a.id - b.id)) {
    const cmd = parseExceptionCommand(c.body);
    if (!cmd || !authorized(c)) continue;
    const edited = c.updated_at !== c.created_at;
    if (cmd.action === 'revoke') revoke(cmd.sha, c.user.login, c.id, 'revoke');
    else if (edited) {
      if (cmd.sha === head) revoke(cmd.sha, c.user.login, c.id, 'edited');
    } else if (cmd.sha === head) approvals.push(c);
  }
  if (eventComment && authorized(eventComment)) {
    const cmd = parseExceptionCommand(eventComment.body);
    if (cmd) revoke(cmd.sha, eventComment.user.login, eventComment.id, 'edited-or-deleted');
  }

  if (revokedStatuses.length) {
    return { approved: false, revocations, reason: `Exception for ${short} permanently revoked (${revokedStatuses[0].description ?? 'revocation status'}).` };
  }
  const headRevoke = revocations.find((r) => r.sha === head);
  if (headRevoke) {
    return { approved: false, revocations, reason: `Exception for ${short} revoked by @${headRevoke.login} in comment ${headRevoke.commentId}; a new head needs a new approval.` };
  }
  const last = approvals[approvals.length - 1];
  if (!last) {
    return { approved: false, revocations, reason: `Restricted: needs \`${command}\` by an admin/maintain user (none found).` };
  }
  return { approved: true, approver: last.user.login, commentId: last.id, revocations, reason: `Exception approved by @${last.user.login} for ${short}.` };
}

/**
 * The value of the required `Governance · merge eligibility` status.
 * success: eligible low PR, or restricted PR with a valid exception approval
 * and every non-risk condition met. failure otherwise, with the top reason.
 */
export function decideMergeStatus(state, config = DEFAULT_CONFIG) {
  const tagged = collectReasons(state, config);
  const clip = (t) => (t.length > STATUS_DESCRIPTION_MAX ? `${t.slice(0, STATUS_DESCRIPTION_MAX - 1)}…` : t);
  if (!tagged.length) return { state: 'success', mode: 'low', description: 'Eligible: risk:low and every gate passed.', reasons: [] };
  const nonRisk = tagged.filter((r) => !r.risk);
  const exception = state?.exception;
  if (!nonRisk.length && exception?.approved) {
    return {
      state: 'success',
      mode: 'exception',
      description: clip(`Restricted; exception approved by @${exception.approver}; all non-risk gates passed. Merge manually.`),
      reasons: tagged.map((r) => r.text),
    };
  }
  const top = nonRisk[0]?.text ?? exception?.reason ?? tagged[0].text;
  return { state: 'failure', mode: 'blocked', description: clip(top), reasons: tagged.map((r) => r.text) };
}
