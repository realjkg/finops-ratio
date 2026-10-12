// Read-only Nutanix deployment-type evidence probe. Classifies only from
// provided artifacts; with insufficient, duplicated or conflicting evidence the
// answer is always 'undetermined'. Money is exact (see ../money.ts) and never
// summed across currencies.
import { buildReport, type EvidenceReport } from '../report';
import { toNanos, fmtNanos, normCurrency } from '../money';

export type NutanixDeploymentType = 'nc2_on_public_cloud' | 'onprem_ahv_prism' | 'cost_governance_saas' | 'undetermined';
export type HostingProvider = 'on_prem' | 'aws' | 'azure' | 'gcp' | 'unknown';
export interface NutanixCluster { name: string; hypervisor?: string; hostCount?: number; hostingProvider?: string; reportedCost?: { amount: number | string; currency: string } }
/** Structured fields (serviceName, productCode) are matched; description and tags never are. */
export interface BillLine { lineId: string; serviceName: string; productCode?: string; description?: string; tags?: Record<string, string>; billedCost: number | string; billingCurrency: string }
interface Base { id: string; source: string } // source = the system/export the artifact came from
export type NutanixArtifact =
  | (Base & { kind: 'cluster_export'; clusters: readonly NutanixCluster[] })
  | (Base & { kind: 'prism_inventory'; managementPlane: 'prism_central' | 'prism_element'; clusters: readonly NutanixCluster[] })
  | (Base & { kind: 'cloud_bill_lines'; hostProvider: 'aws' | 'azure' | 'gcp'; lines: readonly BillLine[] })
  | (Base & { kind: 'cost_governance_export'; rowCount: number })
  | (Base & { kind: 'onprem_cost_evidence'; evidenceType: 'depreciation_schedule' | 'license_invoice' | 'showback_export'; rowCount: number });

type Kind = NutanixArtifact['kind'];
type Classified = Exclude<NutanixDeploymentType, 'undetermined'>;
const FAMILY: Record<Kind, string> = { cluster_export: 'inventory', prism_inventory: 'inventory', cloud_bill_lines: 'bill', cost_governance_export: 'governance', onprem_cost_evidence: 'onprem_cost' };

export interface Amounts { gross: string; credits: string; net: string }
export interface NutanixProbeResult {
  deploymentType: NutanixDeploymentType;
  confidence: 'none' | 'medium' | 'high';
  evidenceUsed: { artifactId: string; supports: Classified; why: string }[];
  evidenceMissing: string[];
  conflicts: string[];
  duplicateArtifacts: { id: string; reason: string }[];
  doubleCount: {
    suspected: boolean; basis: string; overlapLineIds: string[]; duplicateLines: string[]; invalidLines: string[];
    amounts: Record<string, Amounts>; comparison: Record<string, 'equal' | 'near' | 'different' | 'not_comparable'>;
  };
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

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '');
const NC2_PRODUCTS = new Set(['nc2', 'nutanix cloud clusters', 'nutanix cloud clusters (nc2)']);
const GOV_PRODUCTS = new Set(['nutanix cost governance', 'nutanix beam']);
const hosting = (v: unknown): HostingProvider => (['on_prem', 'aws', 'azure', 'gcp'].includes(norm(v)) ? (norm(v) as HostingProvider) : 'unknown');
const isCloud = (c: NutanixCluster) => ['aws', 'azure', 'gcp'].includes(hosting(c.hostingProvider));
const lineIs = (set: Set<string>, l: BillLine) => set.has(norm(l.serviceName)) || set.has(norm(l.productCode));
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

type Signal = { artifactId: string; source: string; family: string; type: Classified; why: string };

function signalsFor(a: NutanixArtifact): Signal[] {
  const mk = (type: Classified, why: string): Signal => ({ artifactId: a.id, source: norm(a.source), family: FAMILY[a.kind], type, why });
  if (a.kind === 'cluster_export' || a.kind === 'prism_inventory') {
    const cloud = a.clusters.filter(isCloud);
    const onprem = a.clusters.filter((c) => hosting(c.hostingProvider) === 'on_prem' && norm(c.hypervisor) === 'ahv');
    const out: Signal[] = [];
    if (cloud.length) out.push(mk('nc2_on_public_cloud', `cluster(s) hosted in a public cloud: ${cloud.map((c) => c.name).join(', ')}`));
    if (onprem.length && (a.kind === 'cluster_export' || a.managementPlane === 'prism_central')) out.push(mk('onprem_ahv_prism', `on-prem AHV cluster(s): ${onprem.map((c) => c.name).join(', ')}`));
    return out;
  }
  if (a.kind === 'cost_governance_export') return a.rowCount > 0 ? [mk('cost_governance_saas', 'cost governance export has rows')] : [];
  if (a.kind === 'onprem_cost_evidence') return a.rowCount > 0 ? [mk('onprem_ahv_prism', `${a.evidenceType} has rows`)] : [];
  const out: Signal[] = [];
  if (a.lines.some((l) => lineIs(NC2_PRODUCTS, l))) out.push(mk('nc2_on_public_cloud', 'NC2 product charges in a cloud bill'));
  if (a.lines.some((l) => lineIs(GOV_PRODUCTS, l))) out.push(mk('cost_governance_saas', 'cost governance subscription charge in a cloud bill'));
  return out;
}

function doubleCount(artifacts: readonly NutanixArtifact[]): NutanixProbeResult['doubleCount'] {
  const overlapLineIds: string[] = [], duplicateLines: string[] = [], invalidLines: string[] = [];
  const seen = new Set<string>();
  const totals = new Map<string, { gross: bigint; credits: bigint }>();
  let sameProvider = false;
  for (const a of artifacts) {
    if (a.kind !== 'cloud_bill_lines') continue;
    let any = false;
    for (const l of a.lines) {
      if (!lineIs(NC2_PRODUCTS, l)) continue;
      any = true;
      const id = typeof l.lineId === 'string' ? l.lineId : '';
      const nanos = toNanos(l.billedCost), cur = normCurrency(l.billingCurrency);
      if (!id || nanos === null || cur === null) { invalidLines.push(id); continue; }
      if (seen.has(id)) { duplicateLines.push(id); continue; }
      seen.add(id);
      overlapLineIds.push(id);
      const t = totals.get(cur) ?? { gross: BigInt(0), credits: BigInt(0) };
      if (nanos < BigInt(0)) t.credits += nanos; else t.gross += nanos;
      totals.set(cur, t);
    }
    if (any) sameProvider ||= artifacts.some((n) => (n.kind === 'cluster_export' || n.kind === 'prism_inventory') && n.clusters.some((c) => hosting(c.hostingProvider) === a.hostProvider));
  }
  const reported = new Map<string, bigint>(); // Nutanix-side amounts for cloud-hosted clusters
  for (const a of artifacts) {
    if (a.kind !== 'cluster_export' && a.kind !== 'prism_inventory') continue;
    for (const c of a.clusters) {
      const n = toNanos(c.reportedCost?.amount), cur = normCurrency(c.reportedCost?.currency);
      if (n !== null && cur !== null && isCloud(c)) reported.set(cur, (reported.get(cur) ?? BigInt(0)) + n);
    }
  }
  const amounts: Record<string, Amounts> = {};
  const comparison: NutanixProbeResult['doubleCount']['comparison'] = {};
  for (const [cur, t] of totals) {
    const net = t.gross + t.credits;
    amounts[cur] = { gross: fmtNanos(t.gross), credits: fmtNanos(t.credits), net: fmtNanos(net) };
    const r = reported.get(cur);
    const diff = r === undefined ? BigInt(0) : (r > net ? r - net : net - r);
    comparison[cur] = r === undefined ? 'not_comparable' : diff === BigInt(0) ? 'equal' : diff * BigInt(100) <= (net < BigInt(0) ? -net : net) ? 'near' : 'different';
  }
  const suspected = overlapLineIds.length > 0 && sameProvider;
  const basis = suspected
    ? 'NC2 product charges are in the host cloud bill and Nutanix-side artifacts describe clusters on that provider: any Nutanix-side cost for those hosts would duplicate the bill.'
    : overlapLineIds.length ? 'NC2 bill lines exist but no Nutanix-side artifact on that provider was provided: not assessable.' : 'No NC2 product charges observed in provided bills.';
  return { suspected, basis, overlapLineIds, duplicateLines, invalidLines, amounts, comparison };
}

export function createNutanixEvidenceProbe(): NutanixEvidenceProbe {
  return {
    probe(provided) {
      // De-duplicate by content (ignoring id and source) and by (source, kind).
      const kept: NutanixArtifact[] = [], duplicateArtifacts: { id: string; reason: string }[] = [];
      const contents = new Set<string>(), sourceKinds = new Set<string>();
      for (const a of provided) {
        const content = canon({ ...a, id: undefined, source: undefined }), sk = `${norm(a.source)}|${a.kind}`;
        const reason = !norm(a.source) ? 'missing_source' : contents.has(content) ? 'duplicate_content' : sourceKinds.has(sk) ? 'duplicate_source_kind' : '';
        if (reason) { duplicateArtifacts.push({ id: a.id, reason }); continue; }
        contents.add(content); sourceKinds.add(sk); kept.push(a);
      }
      const signals = kept.flatMap(signalsFor);
      const types = [...new Set(signals.map((s) => s.type))];
      const conflicts = types.length > 1 ? [`evidence supports more than one deployment type: ${types.join(', ')}`] : [];
      for (const a of kept) if (new Set(signalsFor(a).map((s) => s.type)).size > 1) conflicts.push(`coexisting_types: artifact ${a.id} shows more than one deployment type`);
      const sources = new Set(signals.map((s) => s.source)), families = new Set(signals.map((s) => s.family));
      const decided = types.length === 1 && sources.size >= 2 && families.size >= 2;
      const evidenceMissing: string[] = (Object.keys(FAMILY) as Kind[]).filter((k) => !kept.some((a) => a.kind === k));
      if (kept.some((a) => (a.kind === 'cluster_export' || a.kind === 'prism_inventory') && a.clusters.some((c) => hosting(c.hostingProvider) === 'unknown'))) evidenceMissing.push('cluster hosting location');
      if (types.length === 1 && !decided) evidenceMissing.push('evidence_not_independent');
      const results: NutanixProbeResult = {
        deploymentType: decided ? (types[0] as Classified) : 'undetermined',
        confidence: !decided ? 'none' : sources.size >= 3 ? 'high' : 'medium',
        evidenceUsed: signals.map((s) => ({ artifactId: s.artifactId, supports: s.type, why: s.why })),
        evidenceMissing,
        conflicts,
        duplicateArtifacts,
        doubleCount: doubleCount(kept),
      };
      return buildReport({
        harness: 'nutanix_deployment_type',
        commands: [`classify ${provided.length} provided artifact(s) in memory; no network`],
        inputs: provided.map((a) => ({ id: a.id, kind: a.kind })),
        results,
        limitations: [
          'Synthetic fixtures only; no live Nutanix, cloud, or Prism access.',
          'Deployment types can co-exist in a real estate; conflicting evidence yields undetermined for a human decision.',
          'Classification needs agreement from at least two distinct sources of distinct families; copies and same-source artifacts count once.',
          'Only structured product fields are matched (exact, normalized); descriptions and tags are ignored.',
        ],
      });
    },
  };
}
