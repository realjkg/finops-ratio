// The worker's redaction must stay LINEAR: it runs synchronously on every
// worker log line, evidence record and in the process crash handler, so a
// super-linear step blocks the process (a 200 KB error message once took 77 s).
//
// Each input runs in a CHILD PROCESS (testing/redactLinearChild.ts, via tsx)
// under a hard wall-clock kill: a catastrophic regex is killed and the test
// FAILS instead of hanging the run. Inside the child every (size, entry point)
// is timed and must finish within BUDGET_MS, and no secret form may survive.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
/**
 * The child runs as `node --import tsx <file>` (one process), not through the
 * tsx wrapper binary, which runs the script in a GRANDCHILD: a SIGKILL on
 * timeout would then hit only the wrapper and leave the runaway redaction
 * running.
 */
const childArgs = (file: string) => ['--import', 'tsx', file];
const CHILD = path.join(__dirname, 'testing', 'redactLinearChild.ts');
const SIZES = [200_000, 2_000_000];
const BUDGET_MS = 2_000;
/** tsx start-up + module load (pg, the CLI) before the first timed call. */
const STARTUP_ALLOWANCE_MS = 8_000;

/** name → JS expression of N (size) and SECRET (the raw secret) building the input. */
const INPUTS: Record<string, string> = {
  'letters run (URL scheme restart)': `'a'.repeat(N)`,
  'scheme-like letters/dots/plus': `'a.b-c+d'.repeat(N / 7)`,
  'a:// repeated': `'a://'.repeat(N / 4)`,
  'URL then long path, no query': `'https://x/' + 'p/'.repeat(N / 2)`,
  'secret-prefix fragments': `SECRET.slice(0, 4).repeat(N / 4)`,
  'repeated partial secrets (one char short)': `SECRET.slice(0, -1).repeat(N / 9)`,
  'URL-encoded partial secrets': `encodeURIComponent(SECRET).slice(0, -1).repeat(N / 15)`,
  'JSON-escaped partial secrets': `JSON.stringify(SECRET).slice(1, -2).repeat(N / 10)`,
  'backslash flood': `'\\\\'.repeat(N)`,
  'quote flood': `'"'.repeat(N)`,
  'percent-encoding flood': `'%25%22%5C'.repeat(N / 9)`,
  'password= repeated': `'password="'.repeat(N / 10)`,
  'Bearer repeated': `'Bearer '.repeat(N / 7)`,
  'full secrets among fragments': `(SECRET + ' ' + SECRET.slice(0, 5) + ' ').repeat(N / 17)`,
};

interface Measurement {
  size: number;
  entry: string;
  ms: number;
  outLen: number;
  leaked: string[];
}

function runCase(expr: string) {
  const started = Date.now();
  const r = spawnSync(process.execPath, childArgs(CHILD), {
    cwd: ROOT,
    env: { ...process.env, RATIO_LINEAR_CASE: JSON.stringify({ expr, sizes: SIZES }) },
    timeout: STARTUP_ALLOWANCE_MS + SIZES.length * 2 * BUDGET_MS,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  return { ...r, wallMs: Date.now() - started };
}

describe('worker redaction is linear on large adversarial inputs (child process, hard kill)', () => {
  for (const [name, expr] of Object.entries(INPUTS)) {
    it(`${name}: 200 KB and 2 MB, both entry points, within ${BUDGET_MS} ms each, no secret form survives`, () => {
      const r = runCase(expr);
      expect(r.signal, `${name}: killed after ${r.wallMs} ms (super-linear redaction)`).toBeNull();
      expect(r.status, `${name}: child failed: ${r.stderr}`).toBe(0);
      const rows = r.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Measurement);
      expect(rows).toHaveLength(SIZES.length * 2);
      for (const m of rows) {
        expect(m.ms, `${name} ${m.entry} @ ${m.size}`).toBeLessThan(BUDGET_MS);
        expect(m.leaked, `${name} ${m.entry} @ ${m.size}`).toEqual([]);
        if (m.entry === 'redact') expect(m.outLen).toBeLessThanOrEqual(4000);
      }
    }, STARTUP_ALLOWANCE_MS + SIZES.length * 2 * BUDGET_MS + 5_000);
  }
});

// Absolute budgets for single steps with a large margin (linear: tens of ms;
// super-linear: seconds to minutes), each in its own child under a hard kill:
// the uncapped URL query rule, and literal-secret matching with a long
// self-similar secret (every position starts an occurrence).
const BUDGET_CHILD = path.join(__dirname, 'testing', 'redactBudgetChild.ts');
const BUDGET_CASE_NAMES = [
  'query rule uncapped, 2 MB a://',
  'scrubLiterals, 4096-char self-similar secret, 2 MB text',
  'jsonLineRedactorFor, 2250-char self-similar secret, 1000 x 4.5 KB strings',
];

describe('single-step budgets (child process, hard kill)', () => {
  for (const name of BUDGET_CASE_NAMES) {
    it(`${name}: < ${BUDGET_MS} ms, no secret survives`, () => {
      const started = Date.now();
      const r = spawnSync(process.execPath, childArgs(BUDGET_CHILD), {
        cwd: ROOT,
        env: { ...process.env, RATIO_BUDGET_CASE: name },
        timeout: STARTUP_ALLOWANCE_MS + BUDGET_MS,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 1 << 20,
      });
      expect(r.signal, `${name}: killed after ${Date.now() - started} ms (super-linear step)`).toBeNull();
      expect(r.status, `${name}: child failed: ${r.stderr}`).toBe(0);
      const m = JSON.parse(r.stdout.trim()) as { ms: number; leaked: string[] };
      expect(m.ms).toBeLessThan(BUDGET_MS);
      expect(m.leaked).toEqual([]);
    }, STARTUP_ALLOWANCE_MS + BUDGET_MS + 5_000);
  }
});
