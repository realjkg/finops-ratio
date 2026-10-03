// Redaction must stay linear: it runs synchronously on upstream error bodies,
// so a quadratic / exponential rule freezes the event loop for every request
// (a 300 KB `http://http://…` body once blocked /api/v1/ai/chat for 11 s).
//
// Each case runs in a CHILD PROCESS with a hard 2 s timeout: a catastrophic
// regex is killed and the test FAILS cleanly instead of hanging the run (a
// synchronous regex cannot be pre-empted inside the test worker).
//
// Two layers are checked on ~300 KB adversarial inputs:
//   - applyRedactionRules: every rule on the FULL text (no input cap) — this is
//     what catches a superlinear rule (quadratic on 300 KB takes seconds);
//   - redactUpstreamText / redactErrorText: the public entry points (capped).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REDACT_TS = path.resolve(__dirname, 'redact.ts');
const SIZE = 300_000;
const BUDGET_MS = 2_000;

/** name → JS expression building the input (evaluated in the child). */
const INPUTS: Record<string, string> = {
  'http:// repeated': `'http://'.repeat(${SIZE} / 7)`,
  'https:// path without query': `'https://x/' + 'a'.repeat(${SIZE})`,
  'PEM BEGIN repeated': `'-----BEGIN A-----'.repeat(${SIZE} / 17)`,
  'PEM BEGIN then 300 KB, no END': `'-----BEGIN RSA PRIVATE KEY-----' + 'Q'.repeat(${SIZE})`,
  'eyJa. repeated': `'eyJa.'.repeat(${SIZE} / 5)`,
  'eyJa- repeated (JWT run without dots)': `'eyJa-'.repeat(${SIZE} / 5)`,
  'PEM END repeated': `'-----END A-----'.repeat(${SIZE} / 15)`,
  'sk- repeated': `'sk-'.repeat(${SIZE} / 3)`,
  'a:// repeated': `'a://'.repeat(${SIZE} / 4)`,
  'scheme-like letters/dots': `'a.b-c+d'.repeat(${SIZE} / 7)`,
  'password=\\" repeated': `'password=\\\\"'.repeat(${SIZE} / 11)`,
  'escaped value then backslash run': `'token=\\\\"' + '\\\\'.repeat(${SIZE})`,
  'double-encoded JSON key repeated': `'{\\\\"password\\\\":'.repeat(${SIZE} / 15)`,
  'env key runs': `'A_'.repeat(${SIZE} / 2) + 'TOKEN'`,
  'mixed-case env key runs': `'Ab_'.repeat(${SIZE} / 3) + 'Password'`,
  'backtick open repeated': "'TOKEN=`'.repeat(" + SIZE + " / 7)",
  'Bearer repeated': `'Bearer '.repeat(${SIZE} / 7)`,
  // URL scan (round 8) shapes.
  'URL with long userinfo full of @': `'https://' + 'a@'.repeat(${SIZE} / 2) + '/p'`,
  'scheme-relative // repeated': `'//a@'.repeat(${SIZE} / 4)`,
  'JSON-escaped scheme repeated': `'http:\\\\/\\\\/'.repeat(${SIZE} / 9)`,
  'query with unterminated quotes repeated': `'https://x/p?"'.repeat(${SIZE} / 13)`,
  'query with escaped-quote runs': `'https://x/p?' + '\\\\"a'.repeat(${SIZE} / 3)`,
  'URL then long path, query at the end': `'https://x/' + 'p/'.repeat(${SIZE} / 2) + '?q=1'`,
  '? and # repeated after a URL': `'https://x/p' + '?#'.repeat(${SIZE} / 2)`,
  // Round 9: password-with-slash extension + backslash authority shapes.
  'host:port URLs repeated in one run (extension)': `'http://a:b/'.repeat(${SIZE} / 11)`,
  'colon authority then a long @-run': `'http://a:b/' + 'x@'.repeat(${SIZE} / 2)`,
  'colon authorities, @ only at the very end': `'http://a:1/'.repeat(${SIZE} / 11) + '@h'`,
  'backslash run in the authority': `'http://' + '\\\\'.repeat(${SIZE})`,
  // Round 11: query / fragment to end of line.
  'one query per JSON-escaped line, repeated': `'https://x/p?a=1\\\\n'.repeat(${SIZE} / 16)`,
  'one query per real line, repeated': `'https://x/p?a=1\\n'.repeat(${SIZE} / 15)`,
  'query then a long even backslash run then n': `'https://x/p?' + '\\\\\\\\'.repeat(${SIZE} / 2) + 'n'`,
  'many URLs with queries on one line': `'https://x/p?q '.repeat(${SIZE} / 15)`,
  'double-escaped scheme repeated': `'http:\\\\\\\\\\\\/\\\\\\\\\\\\/'.repeat(${SIZE} / 13)`,
};

function runInChild(fn: 'applyRedactionRules' | 'redactUpstreamText' | 'redactErrorText', expr: string) {
  const call =
    fn === 'redactErrorText' ? `m.redactErrorText(new Error(input))` : `m.${fn}(input${fn === 'redactUpstreamText' ? ', 300' : ''})`;
  const script =
    `const m = await import(${JSON.stringify(REDACT_TS)});` +
    `const input = ${expr};` +
    `if (input.length < ${SIZE} * 0.9) throw new Error('input too small: ' + input.length);` +
    `const t0 = performance.now(); const out = ${call};` +
    `if (typeof out !== 'string') throw new Error('not a string');` +
    `process.stdout.write(String(Math.round(performance.now() - t0)));`;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
    timeout: BUDGET_MS + 1_000, // + child start-up
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  return { ...r, wallMs: Date.now() - started };
}

describe.each(['applyRedactionRules', 'redactUpstreamText', 'redactErrorText'] as const)('%s stays linear', (fn) => {
  it.each(Object.entries(INPUTS))(
    '%s (~300 KB) finishes within 2 s',
    (_name, expr) => {
      const r = runInChild(fn, expr);
      expect(r.signal, `killed after ${r.wallMs} ms — superlinear rule`).toBeNull();
      expect(r.status, r.stderr).toBe(0);
      expect(Number(r.stdout)).toBeLessThan(BUDGET_MS);
    },
    15_000,
  );
});
