// H3: a row that resolves to no workload carries x_RatioValueRatio 0 on the wire (the FinIO
// validator requires a finite number), but the UI shows its value ratio as N/A, never "0.0×".

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatRatio } from '@/lib/format';
import { FocusRowsCard } from './CostSourcePage';
import { normalizeRows } from './normalize';
import { rawRowsForVersion } from './seed';
import { FocusRowLine } from '@/finio/FinioPage';
import { finioRowsForVersion } from '@/finio/finioRows';

describe('FocusRowsCard value ratio', () => {
  const raw = rawRowsForVersion('1.4').slice(0, 2);
  raw[1] = { ...raw[1], ResourceId: 'arn:aws:ec2:us-east-1:000000000000:instance/i-unknown' };
  delete (raw[1] as { Tags?: unknown }).Tags;
  const { rows } = normalizeRows(raw, 'focus-file-sandbox', '1.4');

  it('renders N/A for an unattributed row and the number for an attributed one', () => {
    expect(rows[1].x_RatioWorkloadId).toBe('');
    expect(rows[1].x_RatioValueRatio).toBe(0);
    const unattributed = renderToStaticMarkup(<FocusRowsCard rows={[rows[1]]} />);
    expect(unattributed).toContain('>N/A<');
    expect(unattributed).not.toContain('0.0×');

    expect(rows[0].x_RatioWorkloadId).not.toBe('');
    const attributed = renderToStaticMarkup(<FocusRowsCard rows={[rows[0]]} />);
    expect(attributed).toContain(formatRatio(rows[0].x_RatioValueRatio));
    expect(attributed).not.toContain('>N/A<');
  });
});

describe('FinIO FocusRowLine value ratio', () => {
  const row = finioRowsForVersion()[0];
  const render = (r: typeof row) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <FocusRowLine row={r} />
        </tbody>
      </table>,
    );

  it('renders N/A for an unattributed row and the number for an attributed one', () => {
    const unattributed = render({ ...row, x_RatioWorkloadId: '', x_RatioValueRatio: 0 });
    expect(unattributed).toContain('>N/A<');
    expect(unattributed).not.toContain('0.0×');

    const attributed = render(row);
    expect(row.x_RatioWorkloadId).not.toBe('');
    expect(attributed).toContain(`${row.x_RatioValueRatio.toFixed(1)}×`);
    expect(attributed).not.toContain('>N/A<');
  });
});
