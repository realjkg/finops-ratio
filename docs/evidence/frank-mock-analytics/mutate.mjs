// Mutation check for the Frank mock (documented manual-list runner).
//
//   node docs/evidence/frank-mock-analytics/mutate.mjs [--jobs=3] [mutant-id ...]
//
// Copies the working tree to a scratch directory (node_modules symlinked), applies ONE
// mutation at a time to the copy, runs the mock test suites against the copy, and reports
// whether at least one named test failed (mutant killed). The real tree is never touched.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  ['legacy-reordered', M + 'respond.ts', 'const LEGACY = { at_risk: atRisk, cost_driver: costDriver, savings, summary };', 'const LEGACY = { at_risk: atRisk, cost_driver: summary, savings, summary };', 'legacy cost-driver answer changed'],
  // ---- challenger round (PR #99): the six surviving mutants, then new guards
  ['other-entities-note-dropped', M + 'respond.ts', 'const notes = others.length > 0 ?', 'const notes = false ?', 'the "you also named" note is dropped'],
  ['payback-zero-onetime', M + 'answersFinance.ts', "${a.migrationOneTimeUsd === 0 ? '0.0 months (no one-time cost)' : months(ok.payback)}", '${months(ok.payback)}', 'zero one-time cost branch removed'],
  ['ops-limit-loosened', M + 'parse.ts', 'v >= 0 && v <= 5)', 'v >= 0 && v <= 5000)', 'ops overhead limit loosened'],
  ['negative-savings-allowed', M + 'world.ts', "field(i, 'savingsOpportunity', RANGE.usd, bad)", "field(i, 'savingsOpportunity', RANGE.signedUsd, bad)", 'negative wire savings accepted'],
  ['user-scan-widened', M + 'memory.ts', 'const USER_SCAN = 500;', 'const USER_SCAN = 50000;', 'user text scan cap widened'],
  ['cached-priced-as-input', M + 'calc.ts', 'const cachedRate = cachedInputRate(model);', 'const cachedRate = model.pricing.input_per_1m;', 'cached tokens priced at the full input rate'],
  ['plain-object-alias-lookup', M + 'entities.ts', 'return Object.hasOwn(table, key) ? table[key] : [];', 'return table[key] ?? [];', 'prototype keys reach alias tables'],
  ['wire-range-dropped', M + 'world.ts', 'const MAX_USD = 1e12;', 'const MAX_USD = 1e308;', 'extreme wire figures accepted'],
  ['control-chars-kept', M + 'world.ts', "out += c < 32 || (c >= 127 && c <= 159) ? ' ' : ch;", 'out += ch;', 'line breaks kept in wire strings'],
  ['unknown-name-off', M + 'respond.ts', 'if (name) return reply(unknownNameText', 'if (false) return reply(unknownNameText', 'unknown capitalized names fall back silently'],
  ['run-rate-warning-off', M + 'answersFinance.ts', 'if (runRate > 0 && ok.saving > runRate) {', 'if (false) {', 'saving above run-rate not flagged'],
  ['ebitda-warning-off', M + 'answersFinance.ts', 'if (scopeSpend > 0 && source.monthly > scopeSpend && red.percent === undefined) {', 'if (false) {', 'reduction above scope spend not flagged'],
  ['invalid-capacity-headline', M + 'answersFinance.ts', 'const valid = ok.coverage >= 1,', 'const valid = true,', 'saving headlined on an undersized cluster'],
  ['reply-unbounded', M + 'respond.ts', 'if (full.length <= MAX_REPLY) return full;', 'return full;', 'reply size not capped'],
  ['list-cap-off', M + 'answerKit.ts', 'return rows.length <= max ? rows :', 'return true ? rows :', 'list rows not capped'],
  ['invalid-amount-fallback', M + 'answersFinance.ts', '    return { source: null, notes };\n  }\n  if (red.monthlyUsd !== undefined) {', '  }\n  if (red.monthlyUsd !== undefined) {', 'a refused amount falls back to a scenario'],
  ['forecast-ebitda-exempt', M + 'intents.ts', "if (!financial || RX.predictWord.test(lower)) return 'forecast';", "if (!financial) return 'forecast';", 'EBITDA forecast phrasing not refused'],
  // ---- second challenger round (PR #102): boundary guards, notes, lookups
  ['range-usd-strict', M + 'world.ts', '(r.exMax ? v >= r.max : v > r.max)', '(r.exMax ? v >= r.max : v >= r.max)', 'upper limits made exclusive'],
  ['range-count-wide', M + 'world.ts', 'const MAX_COUNT = 1e13;', 'const MAX_COUNT = 1e18;', 'count limit widened'],
  ['list-cap-wide', M + 'answerKit.ts', 'rows: string[], max = 20)', 'rows: string[], max = 25)', 'list cap widened'],
  ['reply-cap-wide', M + 'respond.ts', 'const MAX_REPLY = 8000;', 'const MAX_REPLY = 80000;', 'reply cap widened'],
  ['name-cap-wide', M + 'world.ts', 'const MAX_STR = 60;', 'const MAX_STR = 600;', 'name cap widened'],
  ['cache-upper-loose', M + 'world.ts', 'rate: { min: 0, max: 1 }', 'rate: { min: 0, max: 100 }', 'cache rate above 100% accepted'],
  ['cache-lower-loose', M + 'world.ts', 'rate: { min: 0, max: 1 }', 'rate: { min: -1, max: 1 }', 'negative cache rate accepted'],
  ['budget-bound-dropped', M + 'world.ts', "field(s, 'monthlyBudget', RANGE.usd, bad)", "field(s, 'monthlyBudget', RANGE.total, bad)", 'budget bound removed'],
  ['trend-upper-loose', M + 'world.ts', 'trend: { min: -100, max: 1e6,', 'trend: { min: -100, max: 1e9,', 'trend upper bound loosened'],
  ['trend-lower-loose', M + 'world.ts', 'trend: { min: -100, max: 1e6,', 'trend: { min: -1000, max: 1e6,', 'trend lower bound loosened'],
  ['c1-controls-kept', M + 'world.ts', 'c >= 127', 'c >= 160', 'DEL and C1 controls kept'],
  ['notes-unprotected', M + 'respond.ts', '[...safeNotes, ...(tailAt < 0 ? [] : lines.slice(tailAt))]', '(tailAt < 0 ? [] : lines.slice(tailAt))', 'notes dropped from the protected tail'],
  ['quality-note-plain-lookup', M + 'answersDrill.ts', 'Object.hasOwn(MODEL_QUALITY_NOTE, scope.model) ? MODEL_QUALITY_NOTE[scope.model] : undefined', 'MODEL_QUALITY_NOTE[scope.model]', 'prototype key reaches the quality notes'],
  ['unknown-team-check-off', M + 'respond.ts', "if (intent !== 'forecast' && intent !== 'capability') {", 'if (false) {', 'unknown names answered with a silent substitute'],
  ['capitalized-rule-dropped', M + 'entities.ts', 'raw[0] !== raw[0].toLowerCase()', 'true', 'lowercase words treated as names'],
  ['incomplete-initiative-kept', M + 'world.ts', 'nums.some(([, v]) => v === null)', 'false', 'initiatives missing a field reach the legacy renderers'],
  // ---- Copilot round on PR #102: one ingestion policy and routing fixes
  ['legacy-context-unsanitized', M + 'world.ts', 'const drop = new Set(world.rejectedIds);', 'const drop = new Set<string>();', 'legacy answers read rejected workloads'],
  ['summary-range-dropped', M + 'world.ts', "typeof v === 'number' && within(v, range) ? v : fallback", "typeof v === 'number' ? v : fallback", 'summary figures not range-checked'],
  ['field-range-dropped', M + 'world.ts', "if (typeof v === 'number' && within(v, range)) return v;", "if (typeof v === 'number') return v;", 'out-of-range numbers accepted'],
  ['nameless-id-unsanitized', M + 'world.ts', '?? clean(id, MAX_STR)', '?? id', 'workload id used raw as a display name'],
  ['negative-count-allowed', M + 'world.ts', 'count: { min: 0, max: MAX_COUNT, int: true }', 'count: { min: -MAX_COUNT, max: MAX_COUNT, int: true }', 'negative counts accepted'],
  ['predict-with-entity', M + 'intents.ts', 'if (/\\bpredict\\w*/.test(lower) || (', 'if (false || (', 'prediction wording ignored when a scope is named'],
  ['start-team-off', M + 'entities.ts', 'for (const rx of [START_TEAM_RX, TEAM_QUALIFIED_RX])', 'for (const rx of [TEAM_QUALIFIED_RX])', 'team name at the start of a question not detected'],
  ['mentions-not-masked', M + 'entities.ts', 'for (const m of [...mentions].sort((a, b) => b.start - a.start)) t =', 'for (const m of [] as Mention[]) t =', 'recognized entities not masked before the unknown-team scan'],
  ['unpriced-suffix-dropped', M + 'answersFinance.ts', "${ok.unpriced.length > 10 ? `, and ${ok.unpriced.length - 10} more` : ''}", '', 'omitted unpriced count dropped'],
  ['note-cap-dropped', M + 'respond.ts', 'n.length > NOTE_MAX ?', 'false ?', 'oversized notes not bounded'],
  ['unknown-team-with-entity-off', M + 'respond.ts', 'if (team) notes.push(', 'if (false) notes.push(', 'unknown team next to a known entity dropped'],
  ['capital-unknown-legacy-off', M + 'respond.ts', "|| intent === 'legacy' || intent === 'savings'", "|| intent === 'savings'", 'legacy savings questions fall back to the portfolio'],
  ['forecast-financial-exemption-removed', M + 'intents.ts', 'if (!financial || RX.predictWord.test(lower)) return', 'if (true) return', 'finance questions with a time horizon are refused'],
  ['name-slice-wide', M + 'entities.ts', "!raw.includes('\\u00a7') && plausible(raw)) return raw.slice(0, 40);", "!raw.includes('\\u00a7') && plausible(raw)) return raw.slice(0, 400);", 'unknown names not length-capped'],
  ['team-word-limit', M + 'entities.ts', '${WORD}(?:(?:\\\\s*,\\\\s*|\\\\s+)${WORD}){0,3})', '${WORD}(?:(?:\\\\s*,\\\\s*|\\\\s+)${WORD}){0,0})', 'multi-word team names not matched'],
  ['plausible-length-loose', M + 'entities.ts', 'return raw.length >= 2 &&', 'return raw.length >= 1 &&', 'single letters treated as names'],
  ['alongside-note-off', M + 'respond.ts', 'else if (name && explicit) notes.push(', 'else if (false) notes.push(', 'unknown name next to a known one dropped'],
  ['int-check-dropped', M + 'world.ts', '(!r.int || Number.isSafeInteger(v))', '(true)', 'fractional counts accepted'],
  ['floor-dropped', M + 'world.ts', '(!r.floor || v === 0 || Math.abs(v) >= r.floor)', '(true)', 'tiny money values accepted'],
  ['note-suffix-lost', M + 'respond.ts', '${n.slice(0, NOTE_MAX / 2 - 1)}\\u2026${n.slice(-NOTE_MAX / 2)}', '${n.slice(0, NOTE_MAX - 1)}\\u2026', 'a long note loses its meaning suffix'],
  ['legacy-note-dropped', M + 'respond.ts', "[rejectedNote(world) ?? ''].filter(Boolean)", '[]', 'legacy answers hide rejected workloads'],
  ['legacy-unbounded', M + 'respond.ts', 'return reply(bound(r.message.content, ', 'return reply(String(r.message.content) + String(', 'legacy answers skip the reply bound'],
  ['wrong-type-as-absent', M + 'world.ts', 'if (v == null) return null; // absent', "if (typeof v !== 'number') return null;", 'a present non-number reads as absent'],
  ['list-before-off', M + 'entities.ts', '[LIST_NAME_RX, LIST_BEFORE_RX]', '[LIST_NAME_RX]', 'a name before the separator is dropped'],
  ['summary-trusted-on-reject', M + 'world.ts', 'return drop.size === 0 && typeof v', 'return typeof v', 'summary keeps rejected workloads'],
  ['mock-prompt-built', 'pages/api/v1/ai/chat.ts', "adapter.provider === 'mock' ?", 'false ?', 'the mock route formats raw context first'],
  ['jobs-unvalidated', 'docs/evidence/frank-mock-analytics/mutate.mjs', 'jobs < 1) {\n  log(', 'jobs < 1 && false) {\n  log(', 'invalid --jobs accepted'],
  ['team-word-stop-dropped', M + 'entities.ts', 'team teams group groups department departments dept show', 'show', 'team words captured as names'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--jobs='));
const jobs = Number(process.argv.find((a) => a.startsWith('--jobs='))?.slice(7) ?? 3);
if (!Number.isSafeInteger(jobs) || jobs < 1) {
  log('--jobs must be a positive integer');
  process.exit(2);
}
const todo = only.length ? MUTANTS.filter((m) => only.includes(m[0])) : MUTANTS;
// A fresh mkdtemp directory per run (under TMPDIR), one tree copy per worker: concurrent runs never collide.
const work = mkdtempSync(join(tmpdir(), 'frank-mutants-'));

function copyTree(name) {
  const dest = join(work, name);
  cpSync(root, dest, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|\.git|\.next|dist|dist-worker)(\/|$)/.test(src.slice(root.length)),
  });
  symlinkSync(join(root, 'node_modules'), join(dest, 'node_modules'));
  return dest;
}

function run(tree, tag) {
  return new Promise((done) => {
    const out = join(work, `${tag}.json`);
    const p = spawn('npx', ['vitest', 'run', 'src/ai/mock', '--reporter=json', `--outputFile=${out}`], { cwd: tree, stdio: 'ignore' });
    p.on('close', () => {
      if (!existsSync(out)) return done({ failed: ['<runner produced no report>'], total: 0 });
      const j = JSON.parse(readFileSync(out, 'utf8'));
      const failed = j.testResults.flatMap((f) =>
        f.status === 'failed' && f.assertionResults.length === 0
          ? [`${f.name.split('/').pop()} (suite failed to run)`]
          : f.assertionResults.filter((t) => t.status === 'failed').map((t) => `${f.name.split('/').pop()} > ${t.title}`),
      );
      done({ failed, total: j.numTotalTests });
    });
  });
}

const trees = Array.from({ length: Math.max(1, Math.min(jobs, todo.length + 1)) }, (_, k) => copyTree(`tree${k}`));
const baseline = await run(trees[0], 'baseline');
log(`baseline: ${baseline.total} tests, ${baseline.failed.length} failing`);
if (baseline.failed.length) { log(baseline.failed.join('\n')); rmSync(work, { recursive: true, force: true }); process.exit(2); }

const rows = [];
let survived = 0;
let next = 0;
async function worker(tree) {
  while (next < todo.length) {
    const [id, file, find, repl, what] = todo[next++];
    const path = join(tree, file);
    const pristine = readFileSync(join(root, file), 'utf8');
    const hits = pristine.split(find).length - 1;
    if (hits !== 1) { log(`${id}: pattern occurs ${hits}x in ${file} (needs exactly 1)`); survived++; continue; }
    writeFileSync(path, pristine.replace(find, () => repl));
    const r = await run(tree, id);
    writeFileSync(path, pristine);
    const killed = r.failed.length > 0;
    if (!killed) survived++;
    rows.push({ id, what, killed, count: r.failed.length, first: r.failed.slice(0, 2) });
    log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${id} \u2014 ${what} \u2014 ${r.failed.length} failing; e.g. ${r.failed[0] ?? '-'}`);
  }
}
await Promise.all(trees.map(worker));
log(`\n${rows.filter((x) => x.killed).length}/${todo.length} mutants killed, ${survived} survived`);
rmSync(work, { recursive: true, force: true });
process.exit(survived ? 1 : 0);
