import { SimulatedSrmdAdapter } from './simulated';
import { MATURITY_ORDER, SRMD_LABEL, type Maturity, type SrmdAdapter } from './types';

type Seen = Maturity | 'unlabeled';
const rank = (m: Seen) => (MATURITY_ORDER.includes(m as Maturity) ? MATURITY_ORDER.indexOf(m as Maturity) : MATURITY_ORDER.length);
const norm = (m: unknown): Seen => (MATURITY_ORDER.includes(m as Maturity) ? (m as Maturity) : 'unlabeled');
const highest = (xs: Seen[]): Seen => xs.reduce<Seen>((hi, x) => (rank(x) > rank(hi) ? x : hi), 'implemented');

/**
 * What each adapter in this build ACTUALLY claims: the highest maturity found on
 * its descriptor, capability report, every response and every record. A missing
 * or unknown value reads as 'unlabeled' (above every real level), so it cannot hide.
 */
export async function srmdMaturity(adapters: SrmdAdapter[] = [new SimulatedSrmdAdapter()]): Promise<{ ceiling: Seen; label: string; adapters: { id: string; maturity: Seen }[] }> {
  const rows = await Promise.all(
    adapters.map(async (a) => {
      const responses = [await a.listCostRecords(), await a.listTagTaxonomy(), await a.listAccountMappings(), await a.listMigrations(), await a.getControlTotals()];
      const records = responses[0].status === 'ok' ? responses[0].data : [];
      const seen = [a.descriptor, await a.discoverCapabilities(), ...responses, ...records].map((x) => norm((x as { maturity?: unknown } | undefined)?.maturity));
      return { id: a.descriptor.id, maturity: highest(seen) };
    }),
  );
  return { ceiling: highest(rows.map((r) => r.maturity)), label: SRMD_LABEL, adapters: rows };
}
