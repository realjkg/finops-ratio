import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ValueRatioMeter } from './ValueRatioMeter';
import { ratioDomain } from './ratioAxis';

const fill = (html: string) => {
  const m = html.match(/role="meter"[^>]*><div class="[^"]*" style="left:([\d.]+)%;width:([\d.]+)%/);
  if (!m) throw new Error('no fill in ' + html);
  return { left: Number(m[1]), width: Number(m[2]) };
};

describe('ValueRatioMeter', () => {
  it('draws a negative ratio left of the zero line on an axis that extends below zero', () => {
    const domain = ratioDomain([-0.17, 4]);
    const html = renderToStaticMarkup(<ValueRatioMeter ratio={-0.17} size="large" domain={domain} />);
    expect(html).toContain('aria-valuemin="-1"');
    const zero = (1 / 11) * 100;
    const f = fill(html);
    expect(f.width).toBeGreaterThan(0.5); // visible, not a zero-length bar
    expect(f.left + f.width).toBeCloseTo(zero, 1); // fill ends at 0x, runs left of it
    expect(html).toContain('>0×<'); // the origin is labelled once; the negative floor is not labelled
    expect(html).not.toContain('>-1×<');
  });

  it('keeps the original zero-based scale when nothing is negative', () => {
    const html = renderToStaticMarkup(<ValueRatioMeter ratio={4.5} size="large" />);
    expect(html).toContain('aria-valuemin="0"');
    const f = fill(html);
    expect(f.left).toBe(0);
    expect(f.width).toBeCloseTo(45, 5);
  });

  it('labels the reference marks as break-even and a target, never "minimum"', () => {
    const html = renderToStaticMarkup(<ValueRatioMeter ratio={1} size="large" />);
    expect(html).toContain('1× break-even');
    expect(html).toContain('3× target');
    expect(html).not.toMatch(/minimum|below min/i);
  });

  it('names the measure Value / cost', () => {
    expect(renderToStaticMarkup(<ValueRatioMeter ratio={2} />)).toContain('aria-label="Value / cost: 2.0×"');
  });

  it('N/A (null, NaN, Infinity) shows no value, no fill and never prints NaN', () => {
    for (const bad of [null, Number.NaN, Infinity, -Infinity]) {
      const html = renderToStaticMarkup(<ValueRatioMeter ratio={bad} size="large" />);
      expect(html).not.toMatch(/NaN|Infinity/);
      expect(html).toContain('N/A');
      expect(html).not.toContain('aria-valuenow');
      expect(fill(html).width).toBe(0);
    }
  });

  it('aria-valuenow always stays inside [min, max], including ratios above 10x', () => {
    const high = renderToStaticMarkup(<ValueRatioMeter ratio={25} />);
    expect(high).toContain('aria-valuenow="10"');
    expect(high).toContain('aria-valuetext="25.0×"');
    const low = renderToStaticMarkup(<ValueRatioMeter ratio={-40} domain={ratioDomain([-40])} />);
    expect(low).toContain('aria-valuenow="-5"');
    expect(low).toContain('aria-valuemin="-5"');
  });

  it('an extreme negative is clipped at the floor and marked, keeping 0x, 1x and 3x apart', () => {
    const domain = ratioDomain([-40, 4]);
    const html = renderToStaticMarkup(<ValueRatioMeter ratio={-40} size="large" domain={domain} />);
    expect(html).toContain('data-testid="meter-clip"');
    expect(html).toContain('≤ -5×');
    const f = fill(html);
    expect(f.left).toBe(0); // runs the full negative extent, never past the track
    expect(f.left + f.width).toBeCloseTo((5 / 15) * 100, 1);
  });
});
