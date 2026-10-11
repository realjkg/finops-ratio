// Mutation check for the Frank mock (documented manual-list runner).
//
//   node docs/evidence/frank-mock-analytics/mutate.mjs [mutant-id ...]
//
// Copies the working tree to a scratch directory (node_modules symlinked), applies ONE
// mutation at a time to the copy, runs the mock test suites against the copy, and reports
// whether at least one named test failed (mutant killed). The real tree is never touched.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { join, resolve } from 'node:path';

const log = (s) => process.stdout.write(`${s}\n`);
const root = resolve(new URL('../../..', import.meta.url).pathname);
const M = 'src/ai/mock/';

/** id, file, exact text to find (must occur once), replacement, what it models. */
const MUTANTS = [
  ['roi-swap-cost-value', M + 'calc.ts', 'ratio: spend > 0 ? value / spend : null,', 'ratio: value > 0 ? spend / value : null,', 'ROI ratio uses cost / value'],
  ['roi-pct-sign', M + 'format.ts', '((value - spend) / spend) * 100', '((spend - value) / spend) * 100', 'ROI percent sign flipped'],
  ['mean-of-ratios', M + 'calc.ts', 'ratio: spend > 0 ? value / spend : null,', 'ratio: members.length > 0 ? members.reduce((s, w) => s + (w.ratio ?? 0), 0) / members.length : null,', 'group ratio as a mean of ratios'],
  ['skip-team-grouping', M + 'calc.ts', "return world.workloads.filter((w) => w.team === scope.team);", 'return world.workloads;', 'team scope returns every workload'],
  ['rank-grouping', M + 'calc.ts', 'const members = world.workloads.filter((w) => w.team === team);', 'const members = world.workloads;', 'team ranking rows not grouped'],
  ['team-rank-routing-off', M + 'intents.ts', 'if (asksWhichTeam) return', 'if (false && asksWhichTeam) return', 'team questions fall through to workload answers'],
  ['ignore-history', M + 'respond.ts', 'deriveFocus(messages.slice(0, at), world)', 'deriveFocus([], world)', 'memory ignores the message history'],
  ['unbounded-memory', M + 'memory.ts', 'export const MAX_HISTORY = 12;', 'export const MAX_HISTORY = 100000;', 'memory window unbounded'],
  ['assumed-as-measured', M + 'world.ts', 'STATUSES.has(v) ? (v as EvidenceStatus) : undefined;', "STATUSES.has(v) ? ('measured' as EvidenceStatus) : undefined;", 'every evidence status read as measured'],
  ['weakest-link-first-member', M + 'calc.ts', 'evidence: weakestStatus(members.map((w) => w.evidence)),', 'evidence: members[0]?.evidence,', 'group evidence = first member, not the weakest'],
  ['evidence-suffix-dropped', M + 'format.ts', "return ` (value evidence: ${status ?? 'unmarked'})`;", "return '';", 'evidence status removed from answers'],
  ['ignore-overrides', M + 'respond.ts', 'const { overrides, ignored } = parseOverrides(text);', 'const { overrides, ignored } = { overrides: {}, ignored: [] as string[] };', 'migration ignores user overrides'],
  ['payback-division-dropped', M + 'calc.ts', 'payback: saving > 0 ? a.migrationOneTimeUsd / saving : null,', 'payback: saving > 0 ? a.migrationOneTimeUsd : null,', 'payback is not divided by the saving'],
  ['break-even-inverted', M + 'calc.ts', '(selfHost * tokens) / api', '(api * tokens) / selfHost', 'break-even volume formula inverted'],
  ['ops-overhead-dropped', M + 'calc.ts', 'gpuCost * (1 + a.opsOverheadPct)', 'gpuCost', 'ops overhead ignored'],
  ['gpu-min-floor-dropped', M + 'calc.ts', 'a.gpuCount ?? Math.max(a.minGpus, neededGpus)', 'a.gpuCount ?? neededGpus', 'availability floor on GPUs removed'],
  ['cached-tokens-ignored', M + 'calc.ts', 'tokens: inT + outT + cT', 'tokens: inT + outT', 'cached tokens left out of the volume'],
  ['registry-in-out-swapped', M + 'calc.ts', '(inT / 1e6) * model.pricing.input_per_1m +', '(inT / 1e6) * model.pricing.output_per_1m +', 'input tokens priced at the output rate'],
  ['realized-savings-nonzero', M + 'answerKit.ts', "'Realized savings: $0 \u2014 no measured outcome evidence", "'Realized savings: $5,963 \u2014 measured outcome evidence", 'realized savings claimed without evidence'],
  ['ebitda-not-annualized', M + 'calc.ts', 'const annual = monthlyReduction * 12;', 'const annual = monthlyReduction;', 'monthly reduction not annualized'],
  ['ebitda-fabricated-baseline', M + 'calc.ts', 'let base = b.ebitda;', 'let base = b.ebitda ?? 4_200_000;', 'an EBITDA baseline invented when none is given'],
  ['ebitda-negative-pct', M + 'calc.ts', 'out.ebitdaPct = base > 0 ? (annual / base) * 100 : null;', 'out.ebitdaPct = base !== 0 ? (annual / base) * 100 : null;', 'percent computed on a negative baseline'],
  ['gpu-count-validation-dropped', M + 'parse.ts', 'if (!Number.isInteger(v) || v < 1 || v > 100000)', 'if (!Number.isInteger(v) || v > 100000)', 'zero or negative GPUs accepted'],
  ['money-range-dropped', M + 'parse.ts', 'return Number.isFinite(v) && Math.abs(v) <= MAX_ABS_USD ? v : Number.NaN;', 'return v;', 'non-finite money accepted'],
  ['legacy-reordered', M + 'respond.ts', "case 'cost_driver':\n      return costDriver(context);", "case 'cost_driver':\n      return summary(context);", 'legacy cost-driver answer changed'],
];

const only = process.argv.slice(2);
const todo = only.length ? MUTANTS.filter((m) => only.includes(m[0])) : MUTANTS;
const work = mkdtempSync(join(tmpdir(), 'frank-mutants-'));
const copy = join(work, 'tree');
cpSync(root, copy, {
  recursive: true,
  filter: (src) => !/(^|\/)(node_modules|\.git|\.next|dist|dist-worker)(\/|$)/.test(src.slice(root.length)),
});
symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));

function run(tag) {
  const out = join(work, `${tag}.json`);
  spawnSync('npx', ['vitest', 'run', 'src/ai/mock', '--reporter=json', `--outputFile=${out}`], { cwd: copy, encoding: 'utf8' });
  if (!existsSync(out)) return { failed: ['<runner produced no report>'], total: 0 };
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const failed = j.testResults.flatMap((f) =>
    f.status === 'failed' && f.assertionResults.length === 0
      ? [`${f.name.split('/').pop()} (suite failed to run)`]
      : f.assertionResults.filter((t) => t.status === 'failed').map((t) => `${f.name.split('/').pop()} > ${t.title}`),
  );
  return { failed, total: j.numTotalTests };
}

const baseline = run('baseline');
log(`baseline: ${baseline.total} tests, ${baseline.failed.length} failing`);
if (baseline.failed.length) { log(baseline.failed.join('\n')); process.exit(2); }

let survived = 0;
const rows = [];
for (const [id, file, find, repl, what] of todo) {
  const path = join(copy, file);
  const pristine = readFileSync(join(root, file), 'utf8');
  const hits = pristine.split(find).length - 1;
  if (hits !== 1) { log(`${id}: pattern occurs ${hits}x in ${file} (needs exactly 1)`); survived++; continue; }
  writeFileSync(path, pristine.replace(find, () => repl));
  const r = run(id);
  writeFileSync(path, pristine);
  const killed = r.failed.length > 0;
  if (!killed) survived++;
  rows.push({ id, what, killed, count: r.failed.length, first: r.failed.slice(0, 2) });
  log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${id} — ${what} — ${r.failed.length} failing; e.g. ${r.failed[0] ?? '-'}`);
}
log(`\n${rows.filter((x) => x.killed).length}/${todo.length} mutants killed, ${survived} survived`);
writeFileSync(join(work, 'result.json'), JSON.stringify(rows, null, 2));
log(`details: ${join(work, 'result.json')}`);
rmSync(copy, { recursive: true, force: true });
process.exit(survived ? 1 : 0);
