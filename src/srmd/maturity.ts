import { SimulatedSrmdAdapter } from './simulated';
import { MATURITY_ORDER, SRMD_LABEL, type Maturity } from './types';

/** Every adapter shipped in this build. A real adapter is added here only with its own evidence. */
export function srmdMaturity(): { ceiling: Maturity; label: string; adapters: { id: string; maturity: Maturity }[] } {
  const adapters = [new SimulatedSrmdAdapter()].map((a) => ({ id: a.descriptor.id, maturity: a.descriptor.maturity }));
  const ceiling = adapters.reduce<Maturity>((hi, a) => (MATURITY_ORDER.indexOf(a.maturity) > MATURITY_ORDER.indexOf(hi) ? a.maturity : hi), 'implemented');
  return { ceiling, label: SRMD_LABEL, adapters };
}
