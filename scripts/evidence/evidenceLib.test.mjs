// Pure parts of the merge-evidence collector: parsers, status classification (NOT RUN never renders as
// PASS), BigInt fixture totals and the evidence.md renderer.
import { describe, expect, it } from 'vitest';
import { STATUS, browserPlan, cell, classifyGate, dbTestPlan, redact, secretsFromEnv, fixtureRows, formatUnits, gatesItemStatus, parseCsv, parsePlaywrightTotals, parseUnits, parseVitestTotals, renderEvidenceMd, statedTotals, totalsByCurrency } from './evidenceLib.mjs';

describe('parseVitestTotals', () => {
  it('reads a clean run, with ANSI colors', () => {
    const out = '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m296 passed\u001b[39m\u001b[22m\u001b[90m (296)\u001b[39m\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m5031 passed\u001b[39m\u001b[22m\u001b[90m (5031)\u001b[39m\n';
    expect(parseVitestTotals(out)).toEqual({ files: { passed: 296, failed: 0, skipped: 0, todo: 0, total: 296 }, tests: { passed: 5031, failed: 0, skipped: 0, todo: 0, total: 5031 } });
  });
  it('reads failures and skips', () => {
    const t = parseVitestTotals(' Test Files  1 failed | 293 passed (294)\n      Tests  1 failed | 5000 passed | 6 skipped (5007)\n');
    expect(t.files).toMatchObject({ failed: 1, passed: 293, total: 294 });
    expect(t.tests).toMatchObject({ failed: 1, passed: 5000, skipped: 6, total: 5007 });
  });
  it('is null when there is no summary (a crash)', () => {
    expect(parseVitestTotals('Error: Cannot find module')).toBeNull();
  });
});

describe('parsePlaywrightTotals', () => {
  it('reads the list reporter summary', () => {
    expect(parsePlaywrightTotals('  ✓ 1 a\n\n  62 passed (6.0m)\n')).toEqual({ passed: 62, failed: 0, skipped: 0, flaky: 0 });
    expect(parsePlaywrightTotals('  1 failed\n  6 passed (2.1m)\n')).toMatchObject({ passed: 6, failed: 1 });
    expect(parsePlaywrightTotals('no summary')).toBeNull();
  });
});

describe('classifyGate: NOT RUN can never be PASS', () => {
  it('maps each state', () => {
    expect(classifyGate({ ran: true, exitCode: 0 })).toBe(STATUS.PASS);
    expect(classifyGate({ ran: true, exitCode: 1 })).toBe(STATUS.FAIL);
    expect(classifyGate({ ran: false, reason: 'NOT RUN: no database in this environment' })).toBe(STATUS.NOT_RUN);
    expect(classifyGate({ na: true, ran: false })).toBe(STATUS.NA);
  });
  it('a zero exit with failed tests, or with no summary when one is expected, is FAIL', () => {
    expect(classifyGate({ ran: true, exitCode: 0, totals: { files: { failed: 0 }, tests: { passed: 10, failed: 1 } } })).toBe(STATUS.FAIL);
    expect(classifyGate({ ran: true, exitCode: 0, expectTotals: true, totals: null })).toBe(STATUS.FAIL);
    expect(classifyGate({ ran: true, exitCode: 0, totals: { passed: 0, failed: 0 } })).toBe(STATUS.FAIL);
  });
  it('the gates charter item is NOT RUN (not PASS) when any gate did not run, and FAIL wins', () => {
    expect(gatesItemStatus([STATUS.PASS, STATUS.NA])).toBe(STATUS.PASS);
    expect(gatesItemStatus([STATUS.PASS, STATUS.NOT_RUN])).toBe(STATUS.NOT_RUN);
    expect(gatesItemStatus([STATUS.NOT_RUN, STATUS.FAIL])).toBe(STATUS.FAIL);
  });
});

describe('fixture totals (BigInt, independent of app code)', () => {
  it('parses and formats exact decimals', () => {
    expect(formatUnits(parseUnits('0.1') + parseUnits('0.2'))).toBe('0.3000000000');
    expect(formatUnits(parseUnits('-3.14'))).toBe('-3.1400000000');
    expect(() => parseUnits('1e3')).toThrow();
    expect(() => parseUnits('0.12345678901')).toThrow();
  });
  it('sums per currency and counts empty cells as N/A, never 0', () => {
    const t = totalsByCurrency([{ BillingCurrency: 'USD', BilledCost: '1.10', EffectiveCost: '' }, { BillingCurrency: 'USD', BilledCost: '2.20', EffectiveCost: '3' }, { BillingCurrency: 'EUR', BilledCost: '-1', EffectiveCost: '-1' }]);
    expect(t.USD).toEqual({ rows: 2, billed: '3.3000000000', effective: '3.0000000000', naBilled: 0, naEffective: 1 });
    expect(t.EUR.billed).toBe('-1.0000000000');
  });
  it('reads the demo dataset JSON shape and CSV', () => {
    const json = JSON.stringify({ meta: { controlTotals: { USD: { rows: 1 } } }, columns: ['BillingCurrency', 'BilledCost', 'EffectiveCost'], rows: [['USD', '1.5', '1.0']] });
    expect(fixtureRows('a.json', json)).toEqual([{ BillingCurrency: 'USD', BilledCost: '1.5', EffectiveCost: '1.0' }]);
    expect(statedTotals('a.json', json)).toEqual({ USD: { rows: 1 } });
    expect(parseCsv('a,b\r\n"x, ""y""",2\n')).toEqual([{ a: 'x, "y"', b: '2' }]);
    expect(fixtureRows('a.md', 'x')).toBeNull();
  });
});

describe('cell (Markdown table escaping)', () => {
  it('escapes backslashes before pipes, so a trailing backslash cannot unescape a pipe', () => {
    expect(cell('a\\|b\nc')).toBe('a\\\\\\|b c');
    expect(cell('x\\')).toBe('x\\\\');
    expect(cell(null)).toBe('');
  });
});

describe('renderEvidenceMd', () => {
  const base = {
    pr: 179, command: 'node scripts/evidence/collect-pr-evidence.mjs', generatedAt: 'T', mergeBase: 'm',
    head: { sha: 'h'.repeat(40), tree: 't1' }, base: { sha: 'b'.repeat(40), tree: 't0' }, env: { node: 'v22', npm: '10', os: 'linux' },
    charter: [{ id: 1, item: 'All gates green', status: STATUS.NOT_RUN, evidence: 'integration NOT RUN' }, { id: 2, item: 'Challenger re-review', status: STATUS.PENDING, evidence: '<review link>' }],
    gates: [{ name: 'integration', command: 'npm run test:db', status: STATUS.NOT_RUN, exitCode: null, durationSec: null, summary: 'NOT RUN: no database in this environment' }],
    fixtures: { files: [], determinism: [] }, rollback: { status: STATUS.PASS, procedure: 'p', detail: 'd', production: 'git revert' }, knownGaps: ['no database'],
  };
  it('shows NOT RUN and PENDING as such, never PASS, and lists known gaps', () => {
    const md = renderEvidenceMd(base);
    expect(md).toMatch(/\| integration \| `npm run test:db` \| \*\*NOT RUN\*\* \|/);
    expect(md).toMatch(/\| 2 \| Challenger re-review \| \*\*PENDING \(orchestrator\)\*\* \|/);
    expect(md).toMatch(/\| 1 \| All gates green \| \*\*NOT RUN\*\* \|/);
    expect(md).toContain('## Known gaps\n\n- no database');
    expect(md).toContain(`Attests code SHA \`${'h'.repeat(40)}\``);
  });
});

describe('environment plans', () => {
  it('finds URL passwords to redact, and redacts every occurrence', () => {
    const env = { RATIO_TEST_DATABASE_URL: 'postgres://postgres:s3cr3t-Pa55@127.0.0.1:55001/postgres', RATIO_MIGRATE_DATABASE_URL: 'postgres://postgres:s3cr3t-Pa55@127.0.0.1:55001/m', HOME: '/x', OTHER_URL: 'not a url' };
    const secrets = secretsFromEnv(env);
    expect(secrets).toEqual(['s3cr3t-Pa55']);
    expect(redact('connect postgres://postgres:s3cr3t-Pa55@h failed; s3cr3t-Pa55', secrets)).toBe('connect postgres://postgres:[redacted]@h failed; [redacted]');
    expect(secretsFromEnv({ RATIO_TEST_DATABASE_URL: 'postgres://postgres@localhost/postgres' })).toEqual([]);
    expect(secretsFromEnv({ POSTGRES_PASSWORD: 'abcd1234' })).toEqual(['abcd1234']);
  });
  it('runs test:db only with the database, S3 and PG16 client tools; otherwise NOT RUN with the reason', () => {
    expect(dbTestPlan({}).run).toBe(false);
    expect(dbTestPlan({}).reason).toMatch(/^NOT RUN: no database/);
    expect(dbTestPlan({ RATIO_TEST_DATABASE_URL: 'u' }).reason).toMatch(/RATIO_TEST_S3_ENDPOINT, RATIO_PG_DUMP, RATIO_PSQL unset/);
    expect(dbTestPlan({ RATIO_TEST_DATABASE_URL: 'u', RATIO_TEST_S3_ENDPOINT: 's', RATIO_PG_DUMP: 'd', RATIO_PSQL: 'p' })).toEqual({ run: true });
  });
  it('picks an explicit browser path, else Playwright-managed Chromium, else NOT RUN with the install command', () => {
    const yes = () => true;
    const no = () => false;
    expect(browserPlan({ RATIO_EVIDENCE_CHROMIUM: '/b/chrome' }, '/m', yes)).toEqual({ env: { RATIO_CHROMIUM_PATH: '/b/chrome' }, source: 'explicit path' });
    expect(browserPlan({ RATIO_CHROMIUM_PATH: '/c' }, null, yes).env).toEqual({ RATIO_CHROMIUM_PATH: '/c' });
    expect(browserPlan({ RATIO_EVIDENCE_CHROMIUM: '/gone' }, '/m', no).reason).toMatch(/not found at \/gone/);
    expect(browserPlan({}, '/m', yes)).toEqual({ env: {}, source: 'Playwright-managed Chromium' });
    expect(browserPlan({}, '/m', no).reason).toMatch(/npx playwright install chromium/);
    expect(browserPlan({}, null, yes).env).toBeNull();
  });
});
