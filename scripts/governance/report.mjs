// Exception report + label computation for the governance workflow. Pure.

export const REPORT_MARKER = '<!-- ratio-governance:risk-report -->';
const GOV_LABEL = /^(?:risk:|restricted:)/;

const FRESH_REVIEW_NOTE =
  '- A fresh Copilot review on the new head is required after each push (the repository does not re-request review on push; eligibility only counts a review whose commit is the current head SHA).';

function cell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\r?\n/g, ' ');
}

/**
 * mainProtection: { protected?: boolean, rulesRequiredChecks?: string[],
 *                   rulesError?: string, error?: string }
 * `protected` comes from GET /branches/main (true for classic protection OR a
 * ruleset; GITHUB_TOKEN cannot read classic protection details). Required checks
 * come from GET /rules/branches/main, which reports rulesets only.
 */
function protectionLines(mp) {
  if (!mp) return [];
  if (mp.error) {
    return [`- Branch protection on \`main\` could not be verified (${cell(mp.error)}); the token likely lacks the rights. Recorded, not blocking.`];
  }
  const lines = [];
  if (mp.protected === false) {
    lines.push('- **main is NOT protected.** Run `scripts/governance/protect-main.mjs` with an admin token. Recorded, not blocking.');
  } else if (mp.protected === true) {
    lines.push('- `main` reports `protected: true` (classic protection or a ruleset; details of classic protection are not readable with GITHUB_TOKEN).');
  }
  if (mp.rulesError) {
    lines.push(`- Rules for \`main\` could not be read (${cell(mp.rulesError)}). Recorded, not blocking.`);
  } else if (Array.isArray(mp.rulesRequiredChecks)) {
    lines.push(
      mp.rulesRequiredChecks.length
        ? `- Ruleset on \`main\` requires status checks: ${mp.rulesRequiredChecks.map((c) => `\`${cell(c)}\``).join(', ')}.`
        : '- No ruleset requires status checks on `main` (classic protection may still; run `protect-main.mjs --dry-run` to see the intended settings).',
    );
  }
  return lines;
}

/** Markdown body for the job summary and the single upserted PR comment. */
export function buildReport(result, ctx = {}) {
  const sha = ctx.headSha ? ` at \`${String(ctx.headSha).slice(0, 7)}\`` : '';
  const lines = [REPORT_MARKER];
  const prot = protectionLines(ctx.mainProtection);
  const outsider = ctx.outsider
    ? [`- **Never eligible for auto-merge:** ${cell(ctx.outsider)}. Classification is informational only.`]
    : [];

  if (result.risk === 'low') {
    lines.push(`### Governance: risk:low${sha}`, '');
    lines.push('No restricted paths or diff patterns matched. "Low" means heuristically low, not proven safe: the rules in `scripts/governance/risk-rules.json` are pattern-based.');
    lines.push('', 'The merge-eligibility job may enable auto-merge once CI is green, every other check has passed, the independent review has completed on this head and all conversations are resolved.', '');
    lines.push(...outsider, FRESH_REVIEW_NOTE, ...prot);
    return `${lines.join('\n')}\n`;
  }

  lines.push(`### Governance EXCEPTION REPORT — risk:restricted${sha}`, '');
  lines.push(`Restricted classes: ${result.classes.map((c) => `\`${c}\``).join(', ')}`, '');
  lines.push('| Path | Class | Rule |', '| --- | --- | --- |');
  for (const r of result.reasons) {
    lines.push(`| \`${cell(r.path || '(change set)')}\` | \`${cell(r.class)}\` | \`${cell(r.rule)}\` |`);
  }

  // Trusted platform author + change set provably clear of the gate's own
  // files: the QA bar is the merge gate, so this report must NOT send the
  // owner to the exception queue. Gate files touched (or the change set
  // unknown/truncated): the exception queue stays, for any author.
  // ctx.trustedAuthor is the trusted LOGIN (or null/undefined).
  if (ctx.trustedAuthor && ctx.touchesGovernanceGate === false) {
    lines.push('', `#### Auto-merge at the QA bar (trusted platform author @${ctx.trustedAuthor})`, '');
    lines.push(`Auto-merge is NOT blocked by the restricted classification for this PR: its author @${ctx.trustedAuthor} is a trusted platform actor (\`TRUSTED_ACTOR_LOGINS\` in \`scripts/governance/eligibility.mjs\`) and the change set does not touch the governance gate's own files (\`.github/workflows/governance.yml\`, \`scripts/governance/**\`). Per the owner's standing directive — auto-merge PRs that are QA'ed and properly tested without defects — the merge-eligibility job enables squash auto-merge once every computable gate is green: genuine CI on every qualifying run, a Copilot review on the head SHA, zero unresolved review threads, every other check run and commit status successful, same-repo PR, no shared head, not a draft, base \`main\`. No \`/exception-approve\` is needed on this path.`, '');
    lines.push('Not verified mechanically by this workflow (the honest limit of the QA bar, accepted by policy for this author): challenger re-review evidence, operational evidence, and rollback verification are not gated here.', '');
  } else {
    lines.push('Auto-merge is disabled for this PR. This report replaces waiting for a human: the orchestrator may merge only once every item below is evidenced in the PR body.', '');
    lines.push('#### Evidence required before merge (orchestrator charter)', '');
    lines.push('- [ ] All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build).');
    lines.push('- [ ] Challenger re-review passed with zero open High findings.');
    lines.push('- [ ] Operational evidence complete (exact commands, results, fixture provenance, known gaps).');
    lines.push('- [ ] Rollback verified in test (procedure + result linked).');
    lines.push('- [ ] Merge decision logged with reasoning in the PR body.');
    const full = /^[0-9a-f]{40}$/i.test(String(ctx.headSha ?? '')) ? String(ctx.headSha).toLowerCase() : '<head-sha>';
    lines.push('', '#### Exception queue', '');
    lines.push('This PR can only merge through the exception path. The required status `Governance · merge eligibility` stays `failure` until both of the following hold:');
    lines.push(`- A user with **admin or maintain** permission (the orchestrator or owner) posts a PR comment whose first line is exactly \`/exception-approve ${full}\`, after the independent challenger review evidence is recorded in the PR. Put a link to that challenger review evidence on the following lines: the gate reads only the first line, but the link is the audit trail.`);
    lines.push('- Every non-risk gate passes: genuine CI on every run, a Copilot review on the head, zero unresolved threads, a same-repo PR, no shared head, not a draft, base `main`.');
    lines.push('');
    lines.push('The approval binds to that exact commit SHA. A new head needs a new approval. `/exception-revoke <sha>` revokes an approval, and so does editing or deleting an admin/maintain command comment. Revocation is permanent for that SHA: it is recorded as a `Governance · exception revoked` status, which cannot be deleted. The workflow never enables auto-merge for restricted PRs that touch the governance gate\'s own files; merge manually once the status is green.');
  }
  lines.push('', '> The non-delegable human gate is the **production environment** (deploys, production data deletion), not this merge.');
  lines.push('', ...outsider, FRESH_REVIEW_NOTE, ...prot);
  return `${lines.join('\n')}\n`;
}

/** Governance labels the PR should carry. */
export function desiredLabels(result) {
  if (result.risk === 'low') return ['risk:low'];
  return ['risk:restricted', ...result.classes.map((c) => `restricted:${c}`)];
}

/** Minimal add/remove set; never touches non-governance labels. */
export function labelChanges(current, desired) {
  const cur = new Set(current);
  const want = new Set(desired);
  return {
    add: desired.filter((l) => !cur.has(l)),
    remove: current.filter((l) => GOV_LABEL.test(l) && !want.has(l)),
  };
}
