// Exception report + label computation for the governance workflow. Pure.

export const REPORT_MARKER = '<!-- ratio-governance:risk-report -->';
const GOV_LABEL = /^(?:risk:|restricted:)/;

const OWNER_ONLY_CLASSES = new Set(['retention', 'deployment']);

function cell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\r?\n/g, ' ');
}

function protectionLine(mainProtection) {
  if (!mainProtection) return null;
  if (mainProtection.error) {
    return `- Branch protection on \`main\` could not be verified (${cell(mainProtection.error)}); the token likely lacks admin rights. Recorded, not blocking.`;
  }
  if (mainProtection.protected === false) {
    return '- **main is NOT protected.** Run `scripts/governance/protect-main.mjs` with an admin token. Recorded, not blocking.';
  }
  return '- Branch protection on `main`: enabled.';
}

/** Markdown body for the job summary and the single upserted PR comment. */
export function buildReport(result, ctx = {}) {
  const sha = ctx.headSha ? ` at \`${String(ctx.headSha).slice(0, 7)}\`` : '';
  const lines = [REPORT_MARKER];
  const prot = protectionLine(ctx.mainProtection);

  if (result.risk === 'low') {
    lines.push(`### Governance: risk:low${sha}`, '');
    lines.push('No restricted paths or diff patterns matched. The merge-eligibility job may enable auto-merge once every check is green, the independent review has completed and all conversations are resolved.');
    if (prot) lines.push('', prot);
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
  const ownerOnly = result.classes.filter((c) => OWNER_ONLY_CLASSES.has(c));
  if (ownerOnly.length) {
    lines.push('', `> **Owner checkpoint:** classes ${ownerOnly.map((c) => `\`${c}\``).join(', ')} may carry production-deploy or data-retention/deletion impact, which is NOT delegable to the orchestrator. Confirm there is no such impact or escalate to the owner.`);
  }
  if (prot) lines.push('', prot);
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
