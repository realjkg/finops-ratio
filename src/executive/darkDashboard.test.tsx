// Owner decision 2026-10-31: (A) under the Dark theme the Initiative Dashboard sits on
// the dark surfaces instead of a white panel; Light and High contrast keep their values.
// (B) spend figures use the normal text color; status badge and budget bar keep theirs.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PersonaProvider } from '@/components/PersonaProvider';
import { WORKLOADS } from '@/data/workloads';
import { languageFor } from '@/lib/languageMap';
import { TOKEN_COLOR } from '@/lib/scales';
import { BUILT_IN_THEMES } from '@/theme/themes';
import { contrastChecks } from '@/theme/validate';
import { InitiativeCard } from './InitiativeCard';
import { InitiativeDashboard } from './InitiativeDashboard';
import { INITIATIVE_STATUS_META, toInitiativeView } from './initiativeModel';

const EXEC = ['exec-bg', 'exec-surface', 'exec-hover', 'exec-border', 'exec-text', 'exec-muted'] as const;
const execOf = (name: keyof typeof BUILT_IN_THEMES) => Object.fromEntries(EXEC.map((r) => [r, BUILT_IN_THEMES[name].colors[r]]));

describe('Dark theme: executive roles map onto the dark surfaces', () => {
  it('exec-* resolve to deep / slab / raised / edge / txt / sub', () => {
    const d = BUILT_IN_THEMES.dark.colors;
    expect(execOf('dark')).toEqual({
      'exec-bg': d.deep, 'exec-surface': d.slab, 'exec-hover': d.raised,
      'exec-border': d.edge, 'exec-text': d.txt, 'exec-muted': d.sub,
    });
  });

  it('Light and High contrast keep their executive values exactly', () => {
    expect(execOf('light')).toEqual({
      'exec-bg': '#f5f8fb', 'exec-surface': '#ffffff', 'exec-hover': '#edf2f7',
      'exec-border': '#848b97', 'exec-text': '#0f172a', 'exec-muted': '#475569',
    });
    expect(execOf('high-contrast')).toEqual({
      'exec-bg': '#ffffff', 'exec-surface': '#ffffff', 'exec-hover': '#f0f0f0',
      'exec-border': '#4d4d4d', 'exec-text': '#000000', 'exec-muted': '#333333',
    });
  });

  it('the text and accents the dashboard draws pass AA on every executive surface', () => {
    const drawn = ['exec-text', 'exec-muted', 'txt', 'sub', 'value', 'cost', 'shape', 'gate', 'unit', 'purple'];
    const failing = contrastChecks(BUILT_IN_THEMES.dark)
      .filter((c) => drawn.includes(c.fg) && ['exec-bg', 'exec-surface', 'exec-hover'].includes(c.bg) && !c.pass)
      .map((c) => `${c.fg}/${c.bg} ${c.ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('the dashboard follows the document color scheme instead of forcing light', () => {
    const html = renderToStaticMarkup(<PersonaProvider><InitiativeDashboard /></PersonaProvider>);
    expect(html).toContain('bg-exec-bg');
    expect(html).not.toMatch(/color-scheme:\s*light/);
  });
});

describe('Initiative card: spend is neutral, status colors stay', () => {
  const w = WORKLOADS[0];
  const card = (budget: number) => {
    const view = toInitiativeView({ ...w, costs: { ...w.costs, monthly_budget: budget } });
    return { view, html: renderToStaticMarkup(<InitiativeCard initiative={view} lang={languageFor('executive')} showLens={false} />) };
  };
  const spendTag = (html: string) => /<p[^>]*>\$[\d,]+<span[^>]*>\/mo<\/span><\/p>/.exec(html)?.[0] ?? '';

  it('draws the monthly spend in the normal text color, never the danger color', () => {
    for (const budget of [w.costs.monthly_budget, 1]) {
      const tag = spendTag(card(budget).html);
      expect(tag).toMatch(/class="[^"]*text-exec-text/);
      expect(tag).not.toContain(TOKEN_COLOR.cost);
      expect(tag).not.toContain('style=');
    }
  });

  it('keeps the status badge color and the over-budget bar color', () => {
    const { view, html } = card(1); // spend far over budget
    const meta = INITIATIVE_STATUS_META[view.status];
    expect(html).toContain(`color:${meta.color}`);
    expect(view.budgetConsumedColor).toBe(TOKEN_COLOR.cost);
    expect(html).toContain(`background-color:${TOKEN_COLOR.cost}`);
  });
});
