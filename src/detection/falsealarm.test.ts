// False-alarm guard (checklist 2.2): stationary, weekday-patterned noisy
// series must not produce actionable (warning or critical) findings. Data is
// seeded (mulberry32), so the result is fully deterministic and offline.

import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '@/detection/anomaly';
import { dayAt, synth } from '@/detection/testkit';

describe('false-alarm rate on stationary noisy data', () => {
  it('raises no critical and at most 2 warnings over 2,400 series-days', () => {
    const fleet = Array.from({ length: 40 }, (_, i) =>
      synth({
        n: 90,
        base: 300 + i * 150,
        noise: 0.03 + (i % 5) * 0.02,
        seed: 7000 + i,
        account: `acct-${i}`,
        service: `svc-${i}`,
      }),
    );
    let seriesDays = 0;
    let critical = 0;
    let warning = 0;
    for (let day = 30; day < 90; day += 1) {
      const result = detectAnomalies(fleet, dayAt(day), { groupMinMembers: 99 });
      seriesDays += fleet.length;
      for (const f of result.findings) {
        if (f.severity === 'critical') critical += 1;
        else if (f.severity === 'warning') warning += 1;
      }
    }
    expect(seriesDays).toBe(2400);
    expect(critical).toBe(0);
    expect(warning).toBeLessThanOrEqual(2);
  });
});
