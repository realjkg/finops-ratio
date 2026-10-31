// The three simulated API connections of the demo. The datasets are committed JSON, loaded with a
// dynamic import() when someone presses "Import sample": they are not in the page's main chunk, and
// nothing here touches the network, storage, or a credential.
import { reconcile, type Reconciled } from './reconcile';
import type { ConnectionType, Dataset } from './types';

export interface ConnectionSummary {
  id: string; name: string; connectionType: ConnectionType; typeLabel: string; apiStyle: string; currency: string;
  /** A fixed, simulated timestamp: the fixture never ran. */
  lastImport: string; rowCount: number;
}

/** What the Connectors page shows before anything is imported (kept equal to each file's meta by a test). */
export const CONNECTIONS: ConnectionSummary[] = [
  { id: 'syn-public-cloud-api', name: 'Example Cloud billing API', connectionType: 'public_cloud', typeLabel: 'Public cloud API', apiStyle: 'Provider billing export API (REST)', currency: 'USD', lastImport: '2026-10-30T06:00:00Z', rowCount: 108 },
  { id: 'syn-private-cloud-api', name: 'Example Private Cloud usage API', connectionType: 'private_cloud', typeLabel: 'Private cloud API', apiStyle: 'OpenStack-style usage and chargeback API', currency: 'EUR', lastImport: '2026-10-30T06:20:00Z', rowCount: 109 },
  { id: 'syn-on-premise-api', name: 'Example Datacenter cost allocation API', connectionType: 'on_premise', typeLabel: 'On-premise API', apiStyle: 'Kubernetes cost allocation API (OpenCost-style)', currency: 'USD', lastImport: '2026-10-30T06:40:00Z', rowCount: 106 },
];

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'syn-public-cloud-api': () => import('./data/syn-public-cloud-api.json'),
  'syn-private-cloud-api': () => import('./data/syn-private-cloud-api.json'),
  'syn-on-premise-api': () => import('./data/syn-on-premise-api.json'),
};

/** Reasons that apply to every dataset, shipped in the lazy chunk's companion module. */
async function commonReasons(): Promise<Record<string, string>> {
  return (await import('./commonNaReasons')).COMMON_NA_REASONS;
}

/** Loads one fixture and reconciles it client-side. Rejects for an unknown id. */
export async function importSample(id: string): Promise<Reconciled> {
  const load = Object.hasOwn(LOADERS, id) ? LOADERS[id] : undefined;
  if (!load) throw new Error(`Unknown sample connection: ${id}`);
  const [mod, reasons] = await Promise.all([load(), commonReasons()]);
  return reconcile(mod.default as Dataset, reasons);
}
