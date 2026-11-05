// The cost vocabulary is one module. This test keeps it that way: the definitions say what the
// FOCUS 1.0 terms say, and no UI, report, Frank or agent-description source uses a banned
// synonym ("actual cost" for a billed or effective number, "budget consumed", "value minimum").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, COPY, DEMO_LABEL_PHRASES, VOCAB, targetPolicyText } from './vocabulary';
import { VIEWS } from '@/finops/semantic/views';

const ROOT = join(__dirname, '..', '..');

describe('vocabulary definitions', () => {
  it('keeps Billed cost and Effective cost distinct, with the FOCUS meanings', () => {
    expect(VOCAB.billedCost.label).not.toBe(VOCAB.effectiveCost.label);
    expect(VOCAB.billedCost.definition).toBe('Charges billed for the period.');
    expect(VOCAB.effectiveCost.definition).toMatch(/discounts/);
    expect(VOCAB.effectiveCost.definition).toMatch(/prepaid commitments/);
    expect(VOCAB.billedCost.definition).not.toMatch(/discount|prepaid/i);
  });

  it('uses the owner-approved short labels', () => {
    expect(Object.fromEntries(Object.entries(VOCAB).map(([k, v]) => [k, v.label]))).toEqual({
      billedCost: 'Billed cost',
      effectiveCost: 'Effective cost',
      forecastCost: 'Forecast cost',
      budget: 'Budget',
      budgetUsed: 'Budget used',
      forecastBudgetUse: 'Forecast budget use',
      estimatedBusinessValue: 'Estimated business value',
      valueToCost: 'Value / cost',
      estimatedBudgetConsumption: 'Estimated budget consumption to date',
      estimatedCostToDate: 'Estimated cost to date',
      modeledCost: 'Modeled workload cost',
      monthlyWorkloadCost: 'Monthly workload cost',
      recordedCost: 'Recorded cost to date',
    });
  });

  it('defines Value / cost with its break-even and says it can be negative', () => {
    expect(VOCAB.valueToCost.definition).toMatch(/^Quality-adjusted business value, less modeled harm from misses, divided by workload cost for the same reporting period\./);
    expect(VOCAB.valueToCost.definition).toMatch(/1×/);
    expect(VOCAB.valueToCost.definition).toMatch(/negative/);
  });

  it('never presents the target as a universal standard', () => {
    expect(targetPolicyText(3)).toBe('3× is a policy target configured for this workspace, not a general financial standard.');
    expect(COPY.targetSetBy).toBe('Set in demo configuration');
  });

  it('agent-facing view titles use the vocabulary (ids are unchanged)', () => {
    expect(VIEWS.budget_vs_actual.title).toBe(`${VOCAB.budget.label} vs ${VOCAB.effectiveCost.label.toLowerCase()}`);
    expect(VIEWS.budget_vs_actual.money?.bases).toEqual(['budget', 'effective']);
  });
});

// --- source scan -------------------------------------------------------------------------

// Exact allowlist: a file and the text of the one match that stays, with the reason. Everything else
// in src/ and pages/ is scanned (engagement, ingest and managed connectors included), so a stray
// phrase there still fails. Nothing is allowlisted by directory or whole file.
const ALLOWED: ReadonlyArray<{ file: string; match: RegExp; why: string }> = [
  { file: 'src/costsource/seed.ts', match: /below 3× value floor/, why: 'seeded finding title: a value in the public API contract (src/compat/golden/api.json); displayed through findingPresentation, keyed by id' },
  { file: 'src/data/alerts.ts', match: /Value ratio fell to/, why: 'seeded alert message: a value in the public API contract; displayed through alertPresentation, keyed by alert id' },
  { file: 'src/costsource/AiSpendRatioCard.tsx', match: /file AI spend under other categories/, why: 'FOCUS service-category total on /costsource ("AI spend vs total spend"), a different measure from workload cost' },
  { file: 'src/ai/mock/intents.ts', match: /value ratio\|\\breturns/, why: 'a regex that recognizes what a user types; it must keep matching the old words' },
  { file: 'src/ai/mock/legacy.ts', match: /Its value ratio justifies the spend/, why: 'legacy Frank answer: byte-identical by design (regression test and API golden)' },
  { file: 'src/ai/mock/legacy.ts', match: /value ratios, budget status, and savings/, why: 'legacy Frank help text: byte-identical by design' },
  { file: 'src/lib/vocabulary.ts', match: /./, why: 'the module that defines the banned patterns' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.spec\.|\.d\.ts$|__testkit__/.test(name)) out.push(p);
  }
  return out;
}

/** Drops comments so a code comment is never mistaken for UI copy (and vice versa). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Matches of a pattern in a source file, across line breaks (JSX text wraps), as short contexts. */
export function scanSource(code: string, pattern: RegExp): string[] {
  const flat = stripComments(code).replace(/\s+/g, ' ');
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  return [...flat.matchAll(re)].map((m) => flat.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30).trim());
}

describe('scanSource (the scanner itself)', () => {
  it('finds a phrase split across lines in JSX text', () => {
    expect(scanSource('<p>Monthly\n   Cost</p>', /\bMonthly [Cc]ost\b/)).toHaveLength(1);
  });
  it('ignores comments', () => {
    expect(scanSource('// Monthly Cost\n/* AI Spend */', /Monthly Cost|AI Spend/)).toHaveLength(0);
  });
});

describe('banned synonyms in user-facing sources', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))].map((f) => relative(ROOT, f));

  it('scans the UI, report, Frank and agent-description sources, and the engagement code too', () => {
    for (const must of ['src/findings/FindingsPage.tsx', 'src/executive/reportXlsx.ts', 'src/executive/reportPdf.tsx', 'src/ai/mock/answersRoi.ts', 'src/finops/semantic/views.ts', 'pages/reports.tsx', 'pages/api/v1/ai/chat.ts', 'src/engagement/config.ts']) {
      expect(files, must).toContain(must);
    }
  });

  it.each(BANNED_PHRASES.map((b) => [String(b.pattern), b] as const))('no source uses %s', (_name, banned) => {
    const hits: string[] = [];
    for (const f of files) {
      for (const ctx of scanSource(readFileSync(join(ROOT, f), 'utf8'), banned.pattern)) {
        if (ALLOWED.some((a) => a.file === f && a.match.test(ctx))) continue;
        hits.push(`${f} (use: ${banned.use}) ...${ctx}...`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('every allowlist entry still matches something, so it cannot go stale', () => {
    for (const a of ALLOWED.filter((x) => x.file !== 'src/lib/vocabulary.ts')) {
      expect(readFileSync(join(ROOT, a.file), 'utf8'), a.why).toMatch(a.match);
    }
  });
});

// --- demo data labels ----------------------------------------------------------------------

// API contract values: GET /api/costsource/* returns these names, notes and health details (two are
// pinned by src/compat/golden/api.json). They keep their wording; the UI shows src/costsource/
// sourcePresentation.ts instead (a test there pins it). Error text for an unknown id is not a view.
const DEMO_LABEL_ALLOWED: ReadonlyArray<{ file: string; match: RegExp; why: string }> = [
  { file: 'src/costsource/sandboxSources.ts', match: /name: '(AWS|Azure|GCP) \(synthetic sandbox\)'/, why: 'API descriptor name; displayed through sourcePresentation' },
  { file: 'src/costsource/seed.ts', match: /name: 'ServiceNow \(synthetic demo data\)'/, why: 'API descriptor name; displayed through sourcePresentation' },
  { file: 'src/costsource/ServiceNowAdapter.ts', match: /'ServiceNow CMDB\/ITBM \(synthetic demo data\)/, why: 'API health detail; displayed through sourcePresentation' },
  { file: 'src/costsource/syntheticCloudSeed.ts', match: /serviceName: 'Synthetic Cloud (Storage|Logging)'/, why: 'FOCUS ServiceName values in sandbox rows (API rows hash pinned by the A6 golden)' },
  { file: 'src/costsource/syntheticCloudSeed.ts', match: /Unknown synthetic cloud source/, why: 'error for an unknown source id, not a view' },
  { file: 'src/lib/vocabulary.ts', match: /./, why: 'the module that defines the patterns' },
];

describe('demo data labels in user-facing sources', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))].map((f) => relative(ROOT, f));

  it.each(DEMO_LABEL_PHRASES.map((b) => [String(b.pattern), b] as const))('no view spells out %s', (_name, banned) => {
    const hits: string[] = [];
    for (const f of files) {
      for (const ctx of scanSource(readFileSync(join(ROOT, f), 'utf8'), banned.pattern)) {
        if (DEMO_LABEL_ALLOWED.some((a) => a.file === f && a.match.test(ctx))) continue;
        hits.push(`${f} (use: ${banned.use}) ...${ctx}...`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('every demo-label allowlist entry still matches something', () => {
    for (const a of DEMO_LABEL_ALLOWED.filter((x) => x.file !== 'src/lib/vocabulary.ts')) {
      expect(readFileSync(join(ROOT, a.file), 'utf8'), a.why).toMatch(a.match);
    }
  });

  it('the scanner catches the labels this change removed', () => {
    for (const old of ['Synthetic data · No live connections', 'Sample workspace', 'Basis: demo assumption', 'Import sample', 'Example Cloud billing API', 'only the Static seed is shown', 'Offline sandbox — 6 seeded adapters', 'Imported API connections (synthetic)', 'All sample data is simulated.', 'Verified sample claims are not real customer returns.', 'These samples are simulated.', 'Seed imported · next fixture available']) {
      expect(DEMO_LABEL_PHRASES.some((b) => b.pattern.test(old)), old).toBe(true);
    }
  });
});
