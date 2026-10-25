import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { deriveGateStatus } from '@/frameworks/governanceModel';
import { FuelAndValue } from '@/mission/FuelAndValue';
import { toMissionView } from '@/mission/missionModel';
import { InitiativeCard } from '@/executive/InitiativeCard';
import { toInitiativeView } from '@/executive/initiativeModel';
import { LANGUAGE_MAP } from '@/lib/languageMap';
import { AiSpendRatioView } from '@/costsource/AiSpendRatioCard';
import { fetchAiSpendRatio } from '@/costsource/aiSpendRatio';
import { createCostSourceClient } from '@/costsource';
import { ITBM_CRITICAL_SERVICE_ALLOCATION } from '@/costsource/seed';
import { formatDeltaValueRatio } from '@/prediction/predictors';
import { createPredictionClient } from '@/prediction';
import { PredictionResult } from '@/mission/AdjustmentCards';

const W = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

describe('B3a gates follow the value ratio', () => {
  it.each(WORKLOADS.map((w) => [w.name, w] as const))('%s: Gate 3 passes only at >= 3x', (_n, w) => {
    const s = deriveGateStatus(w);
    if (w.value.value_ratio < 3) expect(s.gatesPassed).toBeLessThan(3);
    if (s.allPassed) expect(w.value.value_ratio).toBeGreaterThanOrEqual(3);
  });
});

describe('B3b budget consumed names its basis in both views', () => {
  it.each(WORKLOADS.map((w) => [w.name, w] as const))('%s', (_n, w) => {
    const m = toMissionView(w);
    const tech = renderToStaticMarkup(<FuelAndValue {...m} />);
    const exec = renderToStaticMarkup(<InitiativeCard initiative={toInitiativeView(w)} lang={LANGUAGE_MAP.executive} showLens={false} />);
    expect(tech).toContain('>Budget consumed · today<');
    expect(exec).toContain('>Budget consumed · month to date<');
  });
});

describe('B3c costsource differences are explained', () => {
  it('ServiceNow = billing export + ITBM allocation on critical services, and the card says so', async () => {
    const r = await fetchAiSpendRatio(createCostSourceClient('mock'), W);
    const total = (id: string) => r.perSource.find((s) => s.sourceId === id)!.result.byCurrency[0].totalCost;
    const critical = WORKLOADS.filter((w) => w.priority === 'critical').reduce((a, w) => a + w.costs.monthly_spend, 0);
    expect(total('servicenow-sandbox') - total('pointfive-sandbox')).toBeCloseTo(critical * (ITBM_CRITICAL_SERVICE_ALLOCATION - 1), 0);
    const html = renderToStaticMarkup(<AiSpendRatioView path="seed" state={{ status: 'ready', report: r }} onSwitch={() => {}} />);
    expect(html).toContain('8.5% ITBM allocation');
    // Pilot P0: the unconfirmed-role source is never described as a cost of record.
    expect(html).toContain('simulated, role unconfirmed, excluded from the headline: illustrative +8.5% ITBM allocation');
    expect(html).not.toMatch(/exceeds the billing export|cost of record/i);
    expect(html).toContain('own bills');
  });
});

describe('M5 delta value ratio is bounded for display', () => {
  it('caps large estimates and keeps small ones exact', () => {
    expect(formatDeltaValueRatio(41.3)).toEqual({ text: '> +10.0×', capped: true });
    expect(formatDeltaValueRatio(-12.7)).toEqual({ text: '< -10.0×', capped: true });
    expect(formatDeltaValueRatio(3.5)).toEqual({ text: '+3.5×', capped: false });
  });
});

describe('M5 the same bound applies on the /mission Proposed Changes card', () => {
  it.each(['wl-support', 'wl-codereview'])('%s model switch and a negative demand-shape delta', async (id) => {
    const p = await createPredictionClient('mock').predictChange({ type: 'model_switch', workloadId: id, fromModel: WORKLOADS.find((x) => x.id === id)!.model, toModel: 'gemini-2.5-flash' });
    for (const delta of [p.impact.deltaValueRatio, -12.7]) {
      const html = renderToStaticMarkup(<PredictionResult prediction={{ ...p, impact: { ...p.impact, deltaValueRatio: delta } }} />);
      expect(html).toMatch(/&(gt|lt); [+-]10\.0/);
      expect(html).toContain('Upper bound, not a forecast');
      expect(html).not.toMatch(/(41\.3|115\.4|12\.7)/);
    }
  });
});
