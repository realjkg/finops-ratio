// Read-only Nutanix deployment-type evidence probe. Classifies only from
// provided artifacts; with insufficient or conflicting evidence the answer is
// always 'undetermined'. Money follows src/costsource: BilledCost is a number
// in its own BillingCurrency and amounts are never summed across currencies.
import { classifyCurrencyFormat } from '@/costsource/focusRows';
import { buildReport, type EvidenceReport } from '../report';

export type NutanixDeploymentType = 'nc2_on_public_cloud' | 'onprem_ahv_prism' | 'cost_governance_saas' | 'undetermined';
export type HostingProvider = 'on_prem' | 'aws' | 'azure' | 'gcp';
export interface NutanixCluster { name: string; hypervisor?: string; hostCount?: number; hostingProvider?: HostingProvider }
export interface BillLine { lineId: string; serviceName: string; description: string; billedCost: number; billingCurrency: string }
export type NutanixArtifact =
  | { id: string; kind: 'cluster_export'; clusters: readonly NutanixCluster[] }
  | { id: string; kind: 'prism_inventory'; managementPlane: 'prism_central' | 'prism_element'; clusters: readonly NutanixCluster[] }
  | { id: string; kind: 'cloud_bill_lines'; hostProvider: Exclude<HostingProvider, 'on_prem'>; lines: readonly BillLine[] }
  | { id: string; kind: 'cost_governance_export'; tenantId?: string; rowCount: number };

type Kind = NutanixArtifact['kind'];
const ALL_KINDS: Kind[] = ['cluster_export', 'prism_inventory', 'cloud_bill_lines', 'cost_governance_export'];
type Classified = Exclude<NutanixDeploymentType, 'undetermined'>;

export interface NutanixProbeResult {
  deploymentType: NutanixDeploymentType;
  confidence: 'none' | 'medium' | 'high';
  evidenceUsed: { artifactId: string; supports: Classified; why: string }[];
  evidenceMissing: string[];
  conflicts: string[];
  doubleCount: { suspected: boolean; basis: string; overlapLineIds: string[]; amountsByCurrency: Record<string, number> };
}

export interface NutanixEvidenceProbe {
  /** Read-only: inputs are never mutated; no I/O. */
  probe(artifacts: readonly NutanixArtifact[]): EvidenceReport<NutanixProbeResult>;
}

/** ILLUSTRATIVE ONLY: what cost evidence could exist per deployment type. Not verified against any real estate. */
export const costEvidenceCatalog = {
  illustrative: true as const,
  note: 'Illustrative, unverified. "unknown" means we do not know whether the evidence exists.',
  byType: {
    nc2_on_public_cloud: [
      { evidence: 'host cloud bill lines for NC2 bare-metal hosts', existence: 'possible' },
      { evidence: 'Nutanix software license or subscription invoice', existence: 'unknown' },
    ],
    onprem_ahv_prism: [
      { evidence: 'hardware depreciation schedule', existence: 'unknown' },
      { evidence: 'license invoice', existence: 'unknown' },
      { evidence: 'Prism-derived showback export', existence: 'unknown' },
    ],
    cost_governance_saas: [
      { evidence: 'Cost Governance tenant export (which clouds it covers is unknown)', existence: 'possible' },
      { evidence: 'subscription invoice', existence: 'unknown' },
    ],
    undetermined: [{ evidence: 'any cost evidence', existence: 'unknown' }],
  } as Record<NutanixDeploymentType, { evidence: string; existence: 'possible' | 'unknown' }[]>,
};

const NC2_RE = /\bnc2\b|nutanix cloud clusters/i;
const GOV_RE = /nutanix.*(cost governance|beam)|(cost governance|beam).*nutanix/i;
type Signal = { artifactId: string; type: Classified; why: string };

function clusterSignals(a: Extract<NutanixArtifact, { clusters: readonly NutanixCluster[] }>): Signal[] {
  const hosted = a.clusters.filter((c) => c.hostingProvider && c.hostingProvider !== 'on_prem');
  const allOnPrem = a.clusters.length > 0 && a.clusters.every((c) => c.hostingProvider === 'on_prem' && c.hypervisor === 'AHV');
  const out: Signal[] = [];
  if (hosted.length) out.push({ artifactId: a.id, type: 'nc2_on_public_cloud', why: `cluster(s) hosted in a public cloud: ${hosted.map((c) => c.name).join(', ')}` });
  if (allOnPrem && (a.kind === 'cluster_export' || a.managementPlane === 'prism_central')) out.push({ artifactId: a.id, type: 'onprem_ahv_prism', why: 'all clusters AHV and on-prem' });
  return out;
}

function signalsFor(a: NutanixArtifact): Signal[] {
  if (a.kind === 'cluster_export' || a.kind === 'prism_inventory') return clusterSignals(a);
  if (a.kind === 'cost_governance_export') return a.rowCount > 0 ? [{ artifactId: a.id, type: 'cost_governance_saas', why: 'cost governance export has rows' }] : [];
  const text = (l: BillLine) => `${l.serviceName} ${l.description}`;
  const out: Signal[] = [];
  if (a.lines.some((l) => NC2_RE.test(text(l)))) out.push({ artifactId: a.id, type: 'nc2_on_public_cloud', why: 'NC2-looking host charges in a cloud bill' });
  if (a.lines.some((l) => GOV_RE.test(text(l)))) out.push({ artifactId: a.id, type: 'cost_governance_saas', why: 'cost governance subscription charge in a cloud bill' });
  return out;
}

function doubleCount(artifacts: readonly NutanixArtifact[]): NutanixProbeResult['doubleCount'] {
  const overlap: BillLine[] = [];
  let sameProviderSide = false;
  for (const a of artifacts) {
    if (a.kind !== 'cloud_bill_lines') continue;
    const lines = a.lines.filter((l) => NC2_RE.test(`${l.serviceName} ${l.description}`));
    if (!lines.length) continue;
    overlap.push(...lines);
    sameProviderSide ||= artifacts.some((n) => (n.kind === 'cluster_export' || n.kind === 'prism_inventory') && n.clusters.some((c) => c.hostingProvider === a.hostProvider));
  }
  const amountsByCurrency: Record<string, number> = {};
  for (const l of overlap) amountsByCurrency[l.billingCurrency] = (amountsByCurrency[l.billingCurrency] ?? 0) + l.billedCost;
  const suspected = overlap.length > 0 && sameProviderSide;
  const basis = suspected
    ? 'NC2-looking host charges are in the host cloud bill and Nutanix-side artifacts describe clusters on that provider: any Nutanix-side cost for those hosts would duplicate the bill.'
    : overlap.length ? 'NC2-looking bill lines exist but no Nutanix-side artifact on that provider was provided: not assessable.' : 'No NC2-looking host charges observed in provided bills.';
  return { suspected, basis, overlapLineIds: overlap.map((l) => l.lineId), amountsByCurrency };
}

export function createNutanixEvidenceProbe(): NutanixEvidenceProbe {
  return {
    probe(artifacts) {
      const signals = artifacts.flatMap(signalsFor);
      const types = [...new Set(signals.map((s) => s.type))];
      const conflicts = types.length > 1 ? [`evidence supports more than one deployment type: ${types.join(', ')}`] : [];
      const artifactCount = new Set(signals.map((s) => s.artifactId)).size;
      const decided = types.length === 1 && artifactCount >= 2;
      const present = new Set<Kind>(artifacts.map((a) => a.kind));
      const evidenceMissing: string[] = ALL_KINDS.filter((k) => !present.has(k));
      const clusterArtifacts = artifacts.filter((a) => a.kind === 'cluster_export' || a.kind === 'prism_inventory');
      if (clusterArtifacts.some((a) => a.clusters.some((c) => !c.hostingProvider))) evidenceMissing.push('cluster hosting location');
      if (types.length === 1 && !decided) evidenceMissing.push('a second independent artifact corroborating the single signal');
      const currencies = artifacts.flatMap((a) => (a.kind === 'cloud_bill_lines' ? a.lines.map((l) => l.billingCurrency) : []));
      const results: NutanixProbeResult = {
        deploymentType: decided ? (types[0] as Classified) : 'undetermined',
        confidence: !decided ? 'none' : artifactCount >= 3 ? 'high' : 'medium',
        evidenceUsed: signals.map((s) => ({ artifactId: s.artifactId, supports: s.type, why: s.why })),
        evidenceMissing,
        conflicts,
        doubleCount: doubleCount(artifacts),
      };
      const limitations = [
        'Synthetic fixtures only; no live Nutanix, cloud, or Prism access.',
        'Deployment types can co-exist in a real estate; conflicting evidence yields undetermined for a human decision.',
        'Classification needs two independent artifacts; one signal is never enough.',
      ];
      if (currencies.some((c) => classifyCurrencyFormat(c) === 'provider-issued')) limitations.push('Provider-issued (non-ISO 4217) currency units present; amounts are kept per unit, never converted.');
      return buildReport({
        harness: 'nutanix_deployment_type',
        commands: [`classify ${artifacts.length} provided artifact(s) in memory; no network`],
        inputs: artifacts.map((a) => ({ id: a.id, kind: a.kind })),
        results,
        limitations,
      });
    },
  };
}
