// Pilot-entry gate (P0). Pure functions so the readiness report and its tests
// share one definition. Nothing here can be satisfied by simulated data.
export const MATURITY = ['implemented', 'simulated', 'integration-tested', 'customer-validated'];
const SIMULATED_ENV = /simulat|synthetic|sandbox|mock|demo|local|fixture|illustrative/i;

/** Declared maturity, downgraded to 'simulated' unless it is a valid claim. */
export function areaMaturity(area, exists) {
  const label = area.maturity;
  if (!MATURITY.includes(label)) return { label: 'simulated', reason: `unknown maturity label: ${label ?? 'missing'}` };
  if (label !== 'customer-validated') return { label, reason: null };
  const { evidence, environment } = area.validation ?? {};
  const why = !evidence || !/(^|\/)evidence\//.test(evidence) || !exists(evidence) ? 'customer-validated needs an existing file under an evidence/ path'
    : !environment || SIMULATED_ENV.test(environment) ? 'customer-validated needs a non-simulated environment name' : null;
  return why ? { label: 'simulated', reason: why } : { label, reason: null };
}

/** Unresolved gates for pilot entry. External tasks carry no resolution state, so they stay open. */
export function pilotEntry(areas, externalTasks, exists) {
  const gates = [
    ...externalTasks.map(t => ({ id: `external:${t.id}`, status: 'unresolved', reason: `requires: ${t.requires ?? 'external acceptance'}` })),
    ...areas.flatMap(a => { const m = areaMaturity(a, exists); return m.label === 'customer-validated' ? [] : [{ id: `area:${a.id}`, status: 'unresolved', reason: `maturity ${m.label}${m.reason ? ` (${m.reason})` : ''}` }]; }),
  ];
  return { pilotEntryReady: gates.length === 0, productionReady: false, gates };
}
