// Leaf module on purpose: the simulation capability route (/api/v1/simulation/status)
// must load on any deployment — including hosts where the sqlite-backed database
// module cannot (Node versions without node:sqlite) — so demo mode can be reported
// affirmatively instead of being inferred from a failed session restore.
export function simulationEnabled(): boolean {
  return process.env.RATIO_SIMULATION === '1' && ['development', 'test'].includes(process.env.RATIO_ENV ?? '');
}
