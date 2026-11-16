import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Methodology from '../../pages/methodology';
import { TcaBreakdown } from '@/outcomes/TcaBreakdown';
import { WORKLOADS } from '@/data/workloads';
import { formatUSD } from '@/lib/format';
import { traceWorkload } from './valueSources';

describe('Methodology page (route /methodology)', () => {
  const html = renderToStaticMarkup(<Methodology />);

  it('states what the data is and the result of the source check', () => {
    expect(html).toContain('>How Value / cost is calculated</h1>');
    expect(html).toContain('Every value input is a stated assumption in a dataset record, not a measurement');
    expect(html).toContain(`Dataset check: ${WORKLOADS.length} of ${WORKLOADS.length} workloads match, to the cent.`);
    expect(html).toContain('It does not show that the dataset itself is right');
    expect(html).toContain('The value inputs cannot be entered or edited in the app today.');
    expect(html).toContain('src/data/workloads.ts');
    expect(html).toContain('docs/design/value-derivation/VALUE-DERIVATION.md');
  });

  it('has one worked example per workload, anchored by id, with the live numbers', () => {
    for (const w of WORKLOADS) {
      const t = traceWorkload(w);
      expect(html).toContain(`id="calc-${w.id}"`);
      expect(html).toContain(`Dataset record ${w.id}`);
      expect(html).toContain(formatUSD(t.steps[2].value!));
      const ratio = t.steps[3].value!;
      expect(html).toContain(`${ratio.toFixed(3)}× (shown as ${ratio.toFixed(1)}×)`);
      expect(html).toContain(`Check passed: stored estimated value and Value / cost against the inputs; value inputs against dataset record ${w.id}`);
    }
  });

  it('never renders a link to a repository host', () => {
    expect(html).not.toMatch(/github\.com|href="https?:/);
  });
});

describe('workload detail links to the worked example', () => {
  it('TcaBreakdown links to its own anchor', () => {
    const w = WORKLOADS.find((x) => x.id === 'wl-fraud')!;
    const html = renderToStaticMarkup(<TcaBreakdown workload={w} />);
    expect(html).toContain('href="/methodology#calc-wl-fraud"');
    // The page explains the headline ratio, not the full-cost estimate above the link.
    expect(html).toContain('How the headline Value / cost is calculated');
  });
});
