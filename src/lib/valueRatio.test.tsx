// One workload, one Value / cost. The stored `value_ratio` is a rounded seed field; the derived ratio is
// the only thing a surface may show or compare. These tests pin that across every surface, using a
// workload whose unrounded ratio straddles a one-decimal rounding boundary (5.3517 -> "5.4x"; the stored
// two-decimal 5.35 would print "5.3x", which is how Reports and Value review once disagreed).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildFindings } from '@/findings/findingsModel';
import { SpendToValueGraph } from '@/findings/SpendToValueGraph';
import { toMissionView } from '@/mission/missionModel';
import { toInitiativeView } from '@/executive/initiativeModel';
import { buildReportModel } from '@/executive/reportModel';
import { buildAIContext } from '@/ai/buildAIContext';
import { derivePortfolioRatio } from '@/lib/derive';
import { formatRatio, formatReturn } from '@/lib/format';
import { KpiCards } from '@/components/detail/KpiCards';
import { workloadValueRatio, workloadValueRatioOrNaN } from './valueRatio';
import type { Workload } from '@/types';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true }) }));

function boundary(): Workload {
  const w = structuredClone(WORKLOADS.find((x) => x.id === 'wl-docsum')!);
  w.costs.monthly_spend = 10000;
  w.value = { ...w.value, revenue_protected: 53517, cost_avoided: 0, harm_from_misses: 0, quality_floor_pass_rate: undefined, total_value: 53517, value_ratio: 5.35 };
  return w;
}

describe('same workload, same Value / cost on every surface', () => {
  const w = boundary();
  const want = '5.4×';

  it('the boundary workload really straddles the rounding boundary', () => {
    expect(workloadValueRatio(w)).toBeCloseTo(5.3517, 4);
    expect(formatRatio(w.value.value_ratio)).toBe('5.3×'); // what the stored field would have shown
    expect(formatRatio(workloadValueRatio(w))).toBe(want);
  });

  it('Value review, Mission, Executive, Report, Frank context and Portfolio agree', () => {
    expect(formatRatio(buildFindings([w])[0].valueRatio)).toBe(want);
    expect(formatRatio(toMissionView(w).valueRatio)).toBe(want);
    expect(formatRatio(toInitiativeView(w).valueRatio)).toBe(want);
    expect(formatRatio(buildReportModel(new Date('2026-06-25T00:00:00Z'), [w]).rows[0].costEfficiency)).toBe(want);
    const ctx = buildAIContext([w], w.id);
    expect(formatRatio(ctx.workloads![0].valueRatio)).toBe(want);
    expect(formatRatio(derivePortfolioRatio([w]).best!.ratio)).toBe(want);
  });

  it('the Workloads KPI note and the scatter chart show the same string', () => {
    expect(renderToStaticMarkup(<KpiCards workload={w} />)).toContain(formatReturn(workloadValueRatio(w)));
    expect(formatReturn(workloadValueRatio(w))).toBe(`Value / cost ${want}`);
    const chart = renderToStaticMarkup(<SpendToValueGraph workloads={[w]} size="large" />);
    expect(chart).toContain(`Value / cost ${want}`);
  });

  it('every seeded workload: all surfaces read the same derived ratio', () => {
    for (const x of WORKLOADS) {
      const r = workloadValueRatio(x);
      expect(buildFindings([x])[0].valueRatio, x.id).toBe(r);
      expect(toMissionView(x).valueRatio, x.id).toBe(r);
      expect(toInitiativeView(x).valueRatio, x.id).toBe(r);
    }
  });
});

describe('invalid cost is N/A everywhere', () => {
  for (const [label, cost] of [['zero', 0], ['negative', -5], ['NaN', Number.NaN], ['Infinity', Infinity]] as const) {
    it(`${label} cost: no ratio, never 0.0x, no NaN or Infinity text, no NaN chart coordinates`, () => {
      const w = structuredClone(WORKLOADS[0]);
      w.costs.monthly_spend = cost;
      expect(workloadValueRatio(w)).toBeNull();
      expect(Number.isNaN(workloadValueRatioOrNaN(w))).toBe(true);
      const f = buildFindings([w])[0];
      expect(f.valueRatio).toBeNull();
      expect(f.targetStatus).toBe('not_available');
      expect(`${f.problem} ${f.why}`).not.toMatch(/NaN|Infinity|\$∞|0\.0×/);
      expect(toMissionView(w).valueRatio).toBeNull();
      expect(buildReportModel(new Date('2026-06-25T00:00:00Z'), [w]).rows[0].costEfficiency).toBeNull();
      expect(formatReturn(workloadValueRatio(w))).toBe('Value / cost N/A');
      const chart = renderToStaticMarkup(<SpendToValueGraph workloads={[w, boundary()]} size="large" />);
      expect(chart).not.toMatch(/NaN|Infinity/);
      expect(chart).toContain('data-workload-id="wl-docsum"');
      expect(chart).not.toContain(`data-workload-id="${w.id}"`);
    });
  }
});

// --- lint-style: no surface reads the stored, rounded value_ratio -------------------------

// Serialized or seed data, not display: the field's type, the seed and simulation writers, the FOCUS
// extension and the contract finding title, the alert type name, and the helper itself.
const MAY_READ_STORED = new Set([
  'src/types/index.ts',
  'src/data/workloads.ts',
  'src/data/alerts.ts',
  'src/lib/valueMath.ts',
  'src/lib/valueRatio.ts',
  'src/costsource/focusRows.ts',
  'src/costsource/normalize.ts',
  'src/costsource/seed.ts',
  'src/simulation/server/workflow.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(p);
  }
  return out;
}

describe('stored value_ratio is not read outside the helper and serialized data', () => {
  const root = join(__dirname, '..', '..');
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'pages'))].map((f) => relative(root, f));
  it('no component, model, page or chart reads value.value_ratio', () => {
    const offenders = files
      .filter((f) => !MAY_READ_STORED.has(f))
      .filter((f) => /value\.value_ratio|\.value_ratio\b/.test(readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')));
    expect(offenders).toEqual([]);
  });
  it('every allowlisted file still mentions value_ratio (the list cannot go stale)', () => {
    for (const f of MAY_READ_STORED) expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/value_ratio/);
  });
});
