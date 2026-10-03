// Exception report + label computation for the governance workflow. Pure.

export const REPORT_MARKER = '<!-- ratio-governance:risk-report -->';
const GOV_LABEL = /^(?:risk:|restricted:)/;

const OWNER_ONLY_CLASSES = new Set(['retention', 'deployment']);

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
  lines.push('Auto-merge is disabled for this PR. This report replaces waiting for a human: the orchestrator may merge only once every item below is evidenced in the PR body.', '');
  lines.push('| Path | Class | Rule |', '| --- | --- | --- |');
  for (const r of result.reasons) {
    lines.push(`| \`${cell(r.path || '(change set)')}\` | \`${cell(r.class)}\` | \`${cell(r.rule)}\` |`);
  }
  lines.push('', '#### Evidence required before merge (orchestrator charter)', '');
  lines.push('- [ ] All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build).');
  lines.push('- [ ] Challenger re-review passed with zero open High findings.');
  lines.push('- [ ] Operational evidence complete (exact commands, results, fixture provenance, known gaps).');
  lines.push('- [ ] Rollback verified in test (procedure + result linked).');
  lines.push('- [ ] Merge decision logged with reasoning in the PR body.');
  lines.push('', '#### Exception queue', '');
  lines.push('This PR can only merge through the exception path. The required status `Governance · merge eligibility` stays `failure` until all of the following hold:');
  lines.push('- A user with **admin or maintain** permission adds the label `exception:approved` after the evidence above is in place.');
  lines.push('- Every non-risk gate passes: genuine CI on every run, a Copilot review on the head, zero unresolved threads, a same-repo PR, no shared head, not a draft, base `main`.');
  lines.push('');
  lines.push('Any push removes the approval, and a new approval is needed for the new head. The workflow never enables auto-merge for restricted PRs; the approver merges.');
  const ownerOnly = result.classes.filter((c) => OWNER_ONLY_CLASSES.has(c));
  if (ownerOnly.length) {
    lines.push('', `> **Owner checkpoint:** classes ${ownerOnly.map((c) => `\`${c}\``).join(', ')} may carry production-deploy or data-retention/deletion impact, which is NOT delegable to the orchestrator. Confirm there is no such impact or escalate to the owner.`);
  }
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
