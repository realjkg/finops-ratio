// The cost vocabulary is one module. This test keeps it that way: the definitions say what the
// FOCUS 1.0 terms say, and no UI, report, Frank or agent-description source uses a banned
// synonym ("actual cost" for a billed or effective number, "budget consumed", "value minimum").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, COPY, VOCAB, targetPolicyText } from './vocabulary';
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
      monthlyRunRate: 'Monthly run rate',
    });
  });

  it('defines Value / cost with its break-even and says it can be negative', () => {
    expect(VOCAB.valueToCost.definition).toMatch(/Business value divided by cost/);
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

// Engagement, ingest and managed-connector code carries the serialized `cost_basis` enum, whose
// stored value 'actual' must not change; none of it is display copy.
// One allowlisted file: the seeded finding title "… — below 3× value floor" is a value in the
// public API contract (src/compat/golden/api.json). Display copy is not renamed through a
// contract; migrating it is a separate, tested change (listed under "Needs owner decision").
const CONTRACT_COPY = new Set(['src/costsource/seed.ts']);

const EXCLUDED = [/^src\/engagement\//, /^src\/ingest\//, /^src\/connectors\/managed\//, /^src\/server\//, /^src\/lib\/vocabulary\.ts$/, /^src\/mock\//];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Drops comments so a code comment is never mistaken for UI copy (and vice versa). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

describe('banned synonyms in user-facing sources', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]
    .map((f) => relative(ROOT, f))
    .filter((f) => !EXCLUDED.some((re) => re.test(f)) && !CONTRACT_COPY.has(f));

  it('scans the UI, report, Frank and agent-description sources', () => {
    for (const must of ['src/findings/FindingsPage.tsx', 'src/executive/reportXlsx.ts', 'src/ai/mock/answersRoi.ts', 'src/finops/semantic/views.ts', 'pages/reports.tsx', 'pages/api/v1/ai/chat.ts']) {
      expect(files, must).toContain(must);
    }
  });

  it.each(BANNED_PHRASES.map((b) => [String(b.pattern), b] as const))('no source uses %s', (_name, banned) => {
    const hits: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(join(ROOT, f), 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (banned.pattern.test(line)) hits.push(`${f}:${i + 1} (use: ${banned.use}) ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
