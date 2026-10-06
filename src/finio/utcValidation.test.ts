import { afterEach, expect, it } from 'vitest';
import { validateFocusRow } from './focusValidation';
import { finioRowsForVersion } from './finioRows';
const prior = process.env.TZ;
afterEach(() => { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; });
it('validates zoneless timestamps in UTC across DST hosts (#64)', () => {
  for (const tz of ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    process.env.TZ = tz;
    for (const date of ['2026-03-08', '2026-03-29']) {
      const row = { ...finioRowsForVersion('1.4')[0], ChargePeriodStart: `${date}T02:30:00`, ChargePeriodEnd: `${date}T03:00:00` };
      expect(validateFocusRow(row), tz).toEqual({ ok: true });
      expect(validateFocusRow({ ...row, ChargePeriodStart: `${date}T03:30:00` }).ok).toBe(false);
    }
  }
});
