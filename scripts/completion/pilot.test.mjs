import fs from 'node:fs';
import { expect, it } from 'vitest';
import { MATURITY, areaMaturity, pilotEntry } from './pilot.mjs';
const read = name => JSON.parse(fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const none = () => false;
const task = { id: 'live-data', kind: 'external', requires: 'Authorized accounts' };

it('labels every readiness area with a known maturity', () => {
  for (const area of read('checklist.json').areas) expect(MATURITY).toContain(areaMaturity(area, none).label);
});
it('downgrades customer-validated without evidence from a non-simulated environment', () => {
  const claim = (extra = {}) => ({ id: 'x', maturity: 'customer-validated', ...extra });
  const ok = { validation: { evidence: 'docs/evidence/x/run.md', environment: 'customer-acceptance-env' } };
  const yes = () => true;
  expect(areaMaturity(claim(), yes)).toMatchObject({ label: 'simulated' });
  expect(areaMaturity(claim({ validation: { evidence: 'notes/run.md', environment: 'customer-acceptance-env' } }), yes).label).toBe('simulated');
  expect(areaMaturity(claim({ validation: { evidence: 'docs/evidence/x/run.md', environment: 'Synthetic sandbox' } }), yes).label).toBe('simulated');
  expect(areaMaturity(claim(ok), none).label).toBe('simulated');
  expect(areaMaturity(claim(ok), yes)).toEqual({ label: 'customer-validated', reason: null });
});
it('keeps pilotEntryReady false while an external task or a non-validated area is unresolved', () => {
  const areas = [{ id: 'a', maturity: 'simulated' }];
  const report = pilotEntry(areas, [task], none);
  expect(report).toMatchObject({ pilotEntryReady: false, productionReady: false });
  expect(report.gates.map(g => g.id)).toEqual(['external:live-data', 'area:a']);
  expect(pilotEntry([], [task], none).pilotEntryReady).toBe(false);
  expect(pilotEntry(areas, [], none).pilotEntryReady).toBe(false);
});
it('is never ready for the checked-in checklist and plan', () => {
  const report = pilotEntry(read('checklist.json').areas, read('plan.json').tasks.filter(t => t.kind === 'external'), none);
  expect(report.pilotEntryReady).toBe(false);
  expect(report.gates.length).toBeGreaterThan(0);
});
