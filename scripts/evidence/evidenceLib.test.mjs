// Pure parts of the merge-evidence collector: CLI parsing, the gate environment allowlist, migration
// target safety, parsers and status rules (NOT RUN never renders as PASS), exact decimals at any scale,
// redaction and the renderer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STATUS, browserPlan, cell, classifyGate, dbTestPlan, decimalsEqual, determinismStatus, fence, fixtureRows, formatDecimal, gateEnv, gatesItemStatus,
  migrationEnv, migrationTarget, parseArgs, parseCsv, parseDecimal, parsePlaywrightTotals, parseVitestTotals, redact, renderEvidenceMd, rollbackStatus,
  secretsFromEnv, statedTotals, sumDecimals, totalsByCurrency, totalsMatch, totalsText,
} from './evidenceLib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parseArgs', () => {
  it('accepts the documented flags', () => {
    expect(parseArgs(['--base', 'main', '--head', 'abc', '--pr', '179', '--migration-smoke', '--port', '4000']).args).toMatchObject({ base: 'main', head: 'abc', pr: '179', 'migration-smoke': true, port: '4000' });
  });
  it('rejects a non-positive or non-integer --pr, flags without values and unknown flags', () => {
    for (const pr of ['0', '-1', '1.5', 'abc', '01']) expect(parseArgs(['--base', 'b', '--head', 'h', '--pr', pr]).error, pr).toMatch(/--pr must be a positive integer/);
    expect(parseArgs(['--base', '--head', 'h', '--pr', '1']).error).toMatch(/--base needs a value/);
    expect(parseArgs(['--base', 'b', '--head', 'h', '--pr']).error).toMatch(/--pr needs a value/);
    expect(parseArgs(['--base', 'b', '--head', 'h', '--pr', '1', '--nope', 'x']).error).toMatch(/unknown flag/);
    expect(parseArgs(['--head', 'h', '--pr', '1']).error).toMatch(/--base is required/);
    expect(parseArgs(['--base', 'b', '--head', 'h', '--pr', '1', '--port', '80']).error).toMatch(/--port/);
  });
});

describe('gate environment allowlist (untrusted PR code never sees the caller environment)', () => {
  const caller = {
    PATH: '/bin', HOME: '/h', TMPDIR: '/t', HTTPS_PROXY: 'http://p', CI: '1',
    RATIO_MIGRATE_DATABASE_URL: 'postgres://owner@prod-db/ratio', RATIO_DATABASE_URL: 'postgres://x@db/ratio', RATIO_READER_DATABASE_URL: 'postgres://r@db/ratio',
    RATIO_TEST_DATABASE_URL: 'postgres://inherited@db/postgres', RATIO_ENV: 'production', AWS_SECRET_ACCESS_KEY: 'k', GITHUB_TOKEN: 'g', NPM_TOKEN: 'n',
    RATIO_EVIDENCE_TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:5000/postgres', RATIO_EVIDENCE_S3_ENDPOINT: 'http://127.0.0.1:5001',
  };
  it('passes only the allowlist and the explicitly mapped evidence inputs', () => {
    const env = gateEnv(caller);
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', HTTPS_PROXY: 'http://p', CI: '1', RATIO_TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:5000/postgres', RATIO_TEST_S3_ENDPOINT: 'http://127.0.0.1:5001' });
    for (const k of ['RATIO_MIGRATE_DATABASE_URL', 'RATIO_DATABASE_URL', 'RATIO_READER_DATABASE_URL', 'RATIO_ENV', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'RATIO_EVIDENCE_TEST_DATABASE_URL']) expect(env, k).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /DATABASE/.test(k))).toEqual(['RATIO_TEST_DATABASE_URL']);
  });
  it('test:db runs only with the evidence database, S3 and PG16 tools; an inherited RATIO_TEST_DATABASE_URL does not count', () => {
    expect(dbTestPlan({ RATIO_TEST_DATABASE_URL: 'postgres://x' }).run).toBe(false);
    expect(dbTestPlan({}).reason).toMatch(/^NOT RUN: no database/);
    expect(dbTestPlan({ RATIO_EVIDENCE_TEST_DATABASE_URL: 'u' }).reason).toMatch(/RATIO_EVIDENCE_S3_ENDPOINT, RATIO_EVIDENCE_PG_DUMP, RATIO_EVIDENCE_PSQL unset/);
    expect(dbTestPlan({ RATIO_EVIDENCE_TEST_DATABASE_URL: 'u', RATIO_EVIDENCE_S3_ENDPOINT: 's', RATIO_EVIDENCE_PG_DUMP: 'd', RATIO_EVIDENCE_PSQL: 'p' })).toEqual({ run: true });
  });
});

describe('migration target safety (down-migrations touch only a throwaway local database)', () => {
  const good = 'postgres://postgres@127.0.0.1:55432/ratio_evidence_migrate';
  it('ignores the app variable RATIO_MIGRATE_DATABASE_URL entirely', () => {
    expect(migrationTarget({ RATIO_MIGRATE_DATABASE_URL: good }).ok).toBe(false);
    expect(migrationTarget({ RATIO_MIGRATE_DATABASE_URL: good }).reason).toMatch(/RATIO_EVIDENCE_SCRATCH_DATABASE_URL unset/);
  });
  it('refuses a production caller even if the target looks safe (the RATIO_ENV override case)', () => {
    for (const [k, v] of [['RATIO_ENV', 'production'], ['NODE_ENV', 'production'], ['RATIO_ENV', 'PROD']]) {
      const env = { RATIO_EVIDENCE_SCRATCH_DATABASE_URL: good, [k]: v };
      expect(migrationTarget(env).reason, `${k}=${v}`).toMatch(/refused: .*production/);
      expect(() => migrationEnv(env)).toThrow(/production/);
    }
  });
  it('refuses a non-loopback host and a database not named ratio_evidence_*', () => {
    expect(migrationTarget({ RATIO_EVIDENCE_SCRATCH_DATABASE_URL: 'postgres://postgres@db.internal:5432/ratio_evidence_x' }).reason).toMatch(/not 127\.0\.0\.1\/localhost/);
    for (const db of ['ratio', 'postgres', 'ratio_evidence_', 'ratio_evidence_X', 'xratio_evidence_a']) expect(migrationTarget({ RATIO_EVIDENCE_SCRATCH_DATABASE_URL: `postgres://p@127.0.0.1:5/${db}` }).ok, db).toBe(false);
    expect(migrationTarget({ RATIO_EVIDENCE_SCRATCH_DATABASE_URL: 'mysql://p@127.0.0.1/ratio_evidence_a' }).ok).toBe(false);
  });
  it('maps the vetted scratch URL to RATIO_MIGRATE_DATABASE_URL only for migration steps, with down allowed there only', () => {
    const env = migrationEnv({ RATIO_EVIDENCE_SCRATCH_DATABASE_URL: good, RATIO_MIGRATE_DATABASE_URL: 'postgres://owner@prod/ratio', PATH: '/bin' });
    expect(env).toMatchObject({ RATIO_MIGRATE_DATABASE_URL: good, RATIO_ENV: 'ci', RATIO_ALLOW_DOWN_MIGRATIONS: '1', PATH: '/bin' });
    expect(gateEnv({ RATIO_EVIDENCE_SCRATCH_DATABASE_URL: good })).not.toHaveProperty('RATIO_MIGRATE_DATABASE_URL');
  });
});

describe('browserPlan', () => {
  it('uses RATIO_EVIDENCE_CHROMIUM, else Playwright-managed Chromium, else NOT RUN with the install command', () => {
    const yes = () => true, no = () => false;
    expect(browserPlan({ RATIO_EVIDENCE_CHROMIUM: '/b/chrome' }, '/m', yes)).toMatchObject({ env: { RATIO_CHROMIUM_PATH: '/b/chrome' } });
    expect(browserPlan({ RATIO_EVIDENCE_CHROMIUM: '/gone' }, '/m', no).reason).toMatch(/not found at \/gone/);
    expect(browserPlan({}, '/m', yes)).toEqual({ env: {}, source: 'Playwright-managed Chromium' });
    expect(browserPlan({}, '/m', no).reason).toMatch(/npx playwright install chromium/);
    expect(browserPlan({ RATIO_CHROMIUM_PATH: '/c' }, null, yes).env).toBeNull(); // not an evidence input
  });
});

describe('redaction', () => {
  it('collects secret-named variables of any length and URL passwords (decoded and raw), and query-string secrets', () => {
    const s = secretsFromEnv({ AWS_SECRET_ACCESS_KEY: 'aws/se+cret', GITHUB_TOKEN: 'ghp_x', DB_PASSWORD: 'p', PATH: '/bin', A_URL: 'postgres://u:p%40ss%2Fw@h/db', B_URL: 'https://h/x?password=q1&user=me', NOTE: 'hello' });
    for (const v of ['aws/se+cret', 'ghp_x', 'p', 'p%40ss%2Fw', 'p@ss/w', 'q1']) expect(s, v).toContain(v);
    expect(s).not.toContain('/bin');
    expect(s).not.toContain('hello');
  });
  it('redacts raw, JSON-escaped and URL-encoded forms', () => {
    const secrets = secretsFromEnv({ API_KEY: 'a"b\\c', A_URL: 'postgres://u:p%40ss@h/db' });
    const text = `raw a"b\\c json ${JSON.stringify('a"b\\c')} url ${encodeURIComponent('a"b\\c')} pw p@ss enc p%40ss`;
    const out = redact(text, secrets);
    expect(out).not.toMatch(/a"b|a\\"b|a%22b|p@ss|p%40ss/);
    expect(out.split('[redacted]').length - 1).toBe(5);
  });
});

describe('parsers', () => {
  it('vitest: the LAST summary wins; ANSI stripped', () => {
    const out = ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n...\n\u001b[2m Test Files \u001b[22m 296 passed (296)\n      Tests  2 failed | 5029 passed (5031)\n';
    expect(parseVitestTotals(out)).toEqual({ kind: 'vitest', files: { passed: 296, failed: 0, skipped: 0, todo: 0, total: 296 }, tests: { passed: 5029, failed: 2, skipped: 0, todo: 0, total: 5031 } });
    expect(parseVitestTotals('Error: Cannot find module')).toBeNull();
  });
  it('playwright: list reporter summary', () => {
    expect(parsePlaywrightTotals('  62 passed (6.0m)\n')).toEqual({ kind: 'playwright', passed: 62, failed: 0, skipped: 0, flaky: 0 });
    expect(parsePlaywrightTotals('  1 failed\n  1 flaky\n  6 passed (2.1m)\n')).toMatchObject({ passed: 6, failed: 1, flaky: 1 });
    expect(parsePlaywrightTotals('no summary')).toBeNull();
  });
});

describe('classifyGate: NOT RUN, N/A, timeouts and spawn errors are never PASS', () => {
  const vt = (tests) => ({ kind: 'vitest', files: { passed: 1, failed: 0, total: 1 }, tests });
  it('maps each state with an explicit note', () => {
    expect(classifyGate({ ran: true, exitCode: 0 }).status).toBe(STATUS.PASS);
    expect(classifyGate({ ran: true, exitCode: 1 }).status).toBe(STATUS.FAIL);
    expect(classifyGate({ ran: false }).status).toBe(STATUS.NOT_RUN);
    expect(classifyGate({ na: true, ran: false }).status).toBe(STATUS.NA);
    expect(classifyGate({ ran: true, exitCode: null, spawnError: 'ENOENT' })).toEqual({ status: STATUS.FAIL, note: 'could not start: ENOENT' });
    expect(classifyGate({ ran: true, exitCode: null, timedOut: true, timeoutMin: 60 })).toEqual({ status: STATUS.FAIL, note: 'timed out after 60 min' });
    expect(classifyGate({ ran: true, exitCode: null, signal: 'SIGKILL' }).status).toBe(STATUS.FAIL);
  });
  it('zero exit with failed tests, no summary, or all tests skipped is FAIL; flaky-only passes are PASS with a note', () => {
    expect(classifyGate({ ran: true, exitCode: 0, totals: vt({ passed: 10, failed: 1, skipped: 0 }) }).status).toBe(STATUS.FAIL);
    expect(classifyGate({ ran: true, exitCode: 0, expectTotals: true, totals: null }).note).toMatch(/no test summary/);
    expect(classifyGate({ ran: true, exitCode: 0, totals: vt({ passed: 0, failed: 0, skipped: 12 }) })).toEqual({ status: STATUS.FAIL, note: 'all 12 tests skipped' });
    expect(classifyGate({ ran: true, exitCode: 0, totals: { kind: 'playwright', passed: 61, failed: 0, skipped: 0, flaky: 1 } })).toEqual({ status: STATUS.PASS, note: '1 flaky (passed on retry)' });
    expect(classifyGate({ ran: true, exitCode: 0, totals: { kind: 'playwright', passed: 0, failed: 0, skipped: 3, flaky: 0 } }).status).toBe(STATUS.FAIL);
  });
  it('the gates charter item is NOT RUN (not PASS) when any gate did not run, and FAIL wins', () => {
    expect(gatesItemStatus([STATUS.PASS, STATUS.NA])).toBe(STATUS.PASS);
    expect(gatesItemStatus([STATUS.PASS, STATUS.NOT_RUN])).toBe(STATUS.NOT_RUN);
    expect(gatesItemStatus([STATUS.NOT_RUN, STATUS.FAIL])).toBe(STATUS.FAIL);
  });
  it('determinism fails on a failed generator, a tracked diff or an untracked file', () => {
    expect(determinismStatus({ gate: STATUS.PASS, trackedDiff: false, untracked: false })).toBe(STATUS.PASS);
    expect(determinismStatus({ gate: STATUS.FAIL, trackedDiff: false, untracked: false })).toBe(STATUS.FAIL);
    expect(determinismStatus({ gate: STATUS.PASS, trackedDiff: true, untracked: false })).toBe(STATUS.FAIL);
    expect(determinismStatus({ gate: STATUS.PASS, trackedDiff: false, untracked: true })).toBe(STATUS.FAIL);
  });
  it('rollback fails on a tree mismatch even when every gate passed, and with no gates', () => {
    expect(rollbackStatus({ tree: 'a', baseTree: 'a', gates: [STATUS.PASS, STATUS.PASS] })).toBe(STATUS.PASS);
    expect(rollbackStatus({ tree: 'a', baseTree: 'b', gates: [STATUS.PASS] })).toBe(STATUS.FAIL);
    expect(rollbackStatus({ tree: 'a', baseTree: 'a', gates: [STATUS.PASS, STATUS.FAIL] })).toBe(STATUS.FAIL);
    expect(rollbackStatus({ tree: 'a', baseTree: 'a', gates: [] })).toBe(STATUS.FAIL);
  });
});

describe('exact decimals at any scale (BigInt, independent of app code)', () => {
  it('parses, sums and compares across scales without losing precision', () => {
    expect(formatDecimal(sumDecimals(['0.1', '0.2']))).toBe('0.3');
    expect(formatDecimal(sumDecimals(['0.00000080000', '1.5', '-0.0000000001']))).toBe('1.50000079990');
    expect(formatDecimal(parseDecimal('-3.14'))).toBe('-3.14');
    expect(formatDecimal(parseDecimal('.5'))).toBe('0.5');
    expect(decimalsEqual('1.50', '1.5000000000')).toBe(true);
    expect(decimalsEqual('1.5', '1.5000000001')).toBe(false);
    expect(() => parseDecimal('1e3')).toThrow();
  });
  it('sums per currency; an empty BilledCost or EffectiveCost is N/A (counted), never 0, and all-N/A renders N/A', () => {
    const t = totalsByCurrency([{ BillingCurrency: 'USD', BilledCost: '', EffectiveCost: '1.10' }, { BillingCurrency: 'USD', BilledCost: '2.20', EffectiveCost: '' }, { BillingCurrency: 'EUR', BilledCost: '', EffectiveCost: '' }]);
    expect(t.USD).toEqual({ rows: 2, billed: '2.20', effective: '1.10', naBilled: 1, naEffective: 1 });
    expect(t.EUR).toEqual({ rows: 1, billed: null, effective: null, naBilled: 1, naEffective: 1 });
    expect(totalsText(t)).toBe('USD: 2 rows, billed 2.20 (+1 N/A), effective 1.10 (+1 N/A); EUR: 1 rows, billed N/A (all 1 rows), effective N/A (all 1 rows)');
    expect(totalsMatch({ USD: { rows: 2, billed: '2.2000000000', effective: '1.1' } }, t)).toBe(true);
    expect(totalsMatch({ USD: { rows: 2, billed: '2.21', effective: '1.1' } }, t)).toBe(false);
  });
  it('recomputes the 11-decimal FOCUS 1.0 sample file without error', () => {
    const p = 'fixtures/focus-1.0-sample/focus_sample.csv';
    const rows = fixtureRows(p, fs.readFileSync(path.join(ROOT, p), 'utf8'));
    expect(rows.length).toBe(1000);
    expect(rows.some((r) => /\.\d{11}$/.test(r.BilledCost))).toBe(true);
    const t = totalsByCurrency(rows);
    expect(Object.values(t).reduce((n, x) => n + x.rows, 0)).toBe(1000);
    for (const x of Object.values(t)) if (x.billed) expect(x.billed).toMatch(/^-?\d+\.\d{11,}$/);
  });
  it('reads the demo dataset JSON shape (also when gzipped by name) and CSV', () => {
    const json = JSON.stringify({ meta: { controlTotals: { USD: { rows: 1 } } }, columns: ['BillingCurrency', 'BilledCost', 'EffectiveCost'], rows: [['USD', '1.5', '1.0']] });
    expect(fixtureRows('a.json', json)).toEqual([{ BillingCurrency: 'USD', BilledCost: '1.5', EffectiveCost: '1.0' }]);
    expect(fixtureRows('a.csv.gz', 'a,b\n1,2\n')).toEqual([{ a: '1', b: '2' }]);
    expect(statedTotals('a.json', json)).toEqual({ USD: { rows: 1 } });
    expect(parseCsv('a,b\r\n"x, ""y""",2\n')).toEqual([{ a: 'x, "y"', b: '2' }]);
    expect(fixtureRows('a.md', 'x')).toBeNull();
  });
});

describe('report rendering', () => {
  it('escapes Markdown cells fully and fences tails so they cannot close early', () => {
    expect(cell('a\\|b\nc')).toBe('a\\\\\\|b c');
    expect(cell(null)).toBe('');
    expect(fence('x ``` y')).toBe('````\nx ``` y\n````');
    expect(fence('plain')).toBe('```\nplain\n```');
  });
  const base = {
    pr: 179, command: 'node c.mjs', generatedAt: 'T', head: { sha: 'h'.repeat(40), tree: 't1' }, base: { ref: 'main', sha: 'b'.repeat(40), tree: 't0' }, mergeBase: { sha: 'm'.repeat(40), tree: 'tm' },
    env: { node: 'v22', npm: '10', os: 'linux' },
    charter: [{ id: 1, item: 'All gates green', status: STATUS.NOT_RUN, evidence: 'integration NOT RUN' }, { id: 2, item: 'Challenger re-review', status: STATUS.PENDING, evidence: '<review link>' }],
    gates: [{ name: 'integration', command: 'npm run test:db', status: STATUS.NOT_RUN, exitCode: null, durationSec: null, summary: 'NOT RUN: no database in this environment' },
      { name: 'unit', command: 'npx vitest', status: STATUS.PASS, exitCode: 0, durationSec: 1, summary: 'ok', tail: 'has ``` inside' }],
    fixtures: { files: [{ path: 'f.csv', error: 'boom', headTotals: { USD: { rows: 1, billed: null, effective: '1', naBilled: 1, naEffective: 0 } } }], determinism: [] },
    rollback: { status: STATUS.PASS, procedure: 'p', detail: 'd', production: 'git revert' }, knownGaps: ['no database'],
  };
  it('shows NOT RUN and PENDING as such, the merge-base note, fixture errors and N/A totals', () => {
    const md = renderEvidenceMd(base);
    expect(md).toMatch(/\| integration \| `npm run test:db` \| \*\*NOT RUN\*\* \|/);
    expect(md).toMatch(/\| 2 \| Challenger re-review \| \*\*PENDING \(orchestrator\)\*\* \|/);
    expect(md).toContain('the requested base is not the merge-base');
    expect(md).toContain('| boom |');
    expect(md).toContain('billed N/A (all 1 rows)');
    expect(md).toContain('````\nhas ``` inside\n````');
    expect(md).toContain('## Known gaps\n\n- no database');
  });
});
