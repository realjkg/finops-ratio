// The month-end projection is labeled by the method it actually uses. It adds the
// PLANNED allocation for the remaining days to month-to-date spend; actual spend
// history does not move it. Expected values are worked by hand, not by this code.
import { describe, expect, it } from 'vitest';
import { projectMonthlySpend } from './forecast';

const base = {
  spendMtd: 1000,
  dailySpendHistory: [10, 10, 10, 10, 10, 10, 10],
  allocation: { weekday: 50, weekend: 20, peak_hour_start: 9, peak_hour_end: 17, peak_multiplier: 1.4 },
  currentDay: 20,
  daysInMonth: 30,
  remainingWeekdays: 7,
};

describe('projectMonthlySpend', () => {
  it('is labeled planned_allocation, not a 7-day average', () => {
    expect(projectMonthlySpend(base).method).toBe('planned_allocation');
  });

  it('projects month-to-date spend plus the planned weekday and weekend amounts', () => {
    // 10 days remain: 7 weekdays × 50 + 3 weekend days × 20 = 410.
    const r = projectMonthlySpend(base);
    expect(r.remainingDays).toBe(10);
    expect(r.projectedEom).toBe(1410);
  });

  it('does not move when only the daily spend history spikes', () => {
    const spiked = projectMonthlySpend({ ...base, dailySpendHistory: [10, 10, 10, 10, 10, 10, 100] });
    expect(spiked.projectedEom).toBe(1410);
    // The 7-day average of actual spend does move: 160 / 7.
    expect(spiked.avgDaily7d).toBeCloseTo(160 / 7, 10);
    expect(projectMonthlySpend(base).avgDaily7d).toBe(10);
  });
});
