// Child process for the absolute redaction budgets in redactLinear.test.ts
// (run with tsx under a hard wall-clock kill: a super-linear step is killed and
// the test FAILS instead of hanging). Input: env RATIO_BUDGET_CASE = one of the
// case names below. Output (stdout): one JSON line { ms, outLen, leaked }.
import { jsonLineRedactorFor, QUERY_RULE, scrubLiterals, secretForms } from '../redact';

const SELF_SIMILAR_SECRET = 'a'.repeat(4096);

const CASES: Record<string, () => { out: string; forms: string[] }> = {
  // The URL query rule alone, UNCAPPED, on 2 MB of 'a://': linear takes tens
  // of ms, the old quadratic rule (R6) takes minutes.
  'query rule uncapped, 2 MB a://': () => {
    const text = 'a://'.repeat(2_000_000 / 4);
    const [re, rep] = QUERY_RULE;
    return { out: typeof rep === 'string' ? text.replace(re, rep) : text.replace(re, rep), forms: [] };
  },
  // A long self-similar secret: every position of the text starts an
  // occurrence. Finding all (overlapping) occurrences must be O(n + m) per
  // form, not O(n * m).
  'scrubLiterals, 4096-char self-similar secret, 2 MB text': () => {
    const forms = secretForms([SELF_SIMILAR_SECRET]);
    return { out: scrubLiterals('a'.repeat(2_000_000), forms), forms };
  },
  'jsonLineRedactorFor, 4096-char self-similar secret, 4000 x 4.5 KB strings': () => {
    const line = jsonLineRedactorFor({ RATIO_BUDGET_SECRET: SELF_SIMILAR_SECRET });
    const chunk = 'a'.repeat(4_500); // just under the input cap: ~400 overlapping occurrences per string
    return { out: line({ rows: Array.from({ length: 4000 }, () => chunk) }), forms: [SELF_SIMILAR_SECRET] };
  },
};

const name = process.env.RATIO_BUDGET_CASE;
if (name) {
  const run = CASES[name];
  if (!run) throw new Error(`unknown case ${name}`);
  const t0 = performance.now();
  const { out, forms } = run();
  const ms = Math.round(performance.now() - t0);
  process.stdout.write(JSON.stringify({ ms, outLen: out.length, leaked: forms.filter((f) => out.includes(f)) }) + '\n');
}
