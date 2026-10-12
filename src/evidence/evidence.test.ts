import { describe, it, expect } from 'vitest';
import { buildReport, MATURITY_CEILING, MATURITY_LEVELS } from './report';
import { createNutanixEvidenceProbe, costEvidenceCatalog } from './nutanix/probe';
import { createServiceNowRoleProbe, emitCostRows, withHumanDecision, RoleNotConfirmedError } from './servicenow/probe';
import * as fx from './fixtures';

const rank = (m: string) => MATURITY_LEVELS.indexOf(m as (typeof MATURITY_LEVELS)[number]);
const ntnx = createNutanixEvidenceProbe();
const sn = createServiceNowRoleProbe();
const cls = (r: ReturnType<typeof sn.probe>, c: string) => r.results.findings.find((f) => f.recordClass === c)!;

describe('EvidenceReport', () => {
  it('has placeholders, and the maturity ceiling is simulated', () => {
    const r = ntnx.probe([]);
    expect(MATURITY_CEILING).toBe('simulated');
    expect(r.revision).toMatch(/placeholder/i);
    expect(r.env).toMatch(/placeholder/i);
    expect(r.commands.length).toBeGreaterThan(0);
    expect(r.limitations.length).toBeGreaterThan(0);
  });
  it('maturity can never exceed simulated', () => {
    for (const m of ['integration-tested', 'customer-validated'] as const) {
      expect(() => buildReport({ harness: 'x', commands: [], inputs: [], results: {}, limitations: [], maturity: m })).toThrow();
    }
    const reports = [ntnx.probe([fx.nc2Inventory, fx.nc2Bill]), sn.probe(fx.snCmdbOnly), ntnx.probe([])];
    for (const r of reports) expect(rank(r.maturity)).toBeLessThanOrEqual(rank('simulated'));
  });
});

describe('NutanixEvidenceProbe', () => {
  it('defaults to undetermined with no evidence and lists what is missing', () => {
    const r = ntnx.probe([]);
    expect(r.results.deploymentType).toBe('undetermined');
    expect(r.results.confidence).toBe('none');
    expect(r.results.evidenceMissing).toEqual(expect.arrayContaining(['cluster_export', 'prism_inventory', 'cloud_bill_lines', 'cost_governance_export']));
  });
  it('does not guess from a single artifact', () => {
    for (const a of [fx.nc2Inventory, fx.onpremInventory, fx.governanceExport, fx.nc2Bill]) {
      const r = ntnx.probe([a]);
      expect(r.results.deploymentType).toBe('undetermined');
      expect(r.results.confidence).toBe('none');
    }
  });
  it('does not guess when hosting location is not stated', () => {
    const noLoc = { id: 'x', kind: 'cluster_export', clusters: [{ name: 'c' }] } as const;
    const r = ntnx.probe([noLoc, { ...noLoc, id: 'y' }]);
    expect(r.results.deploymentType).toBe('undetermined');
    expect(r.results.evidenceMissing).toContain('cluster hosting location');
  });
  it('classifies corroborated evidence and cites what it used', () => {
    const nc2 = ntnx.probe([fx.nc2Inventory, fx.nc2Bill]);
    expect(nc2.results.deploymentType).toBe('nc2_on_public_cloud');
    expect(nc2.results.evidenceUsed.map((e) => e.artifactId).sort()).toEqual(['bill-1', 'inv-1']);
    const onprem = ntnx.probe([fx.onpremInventory, fx.onpremExport]);
    expect(onprem.results.deploymentType).toBe('onprem_ahv_prism');
    expect(ntnx.probe([fx.governanceExport, fx.governanceBill]).results.deploymentType).toBe('cost_governance_saas');
    expect(ntnx.probe([fx.nc2Inventory, fx.nc2Export, fx.nc2Bill]).results.confidence).toBe('high');
  });
  it('returns undetermined with conflicts when evidence disagrees', () => {
    const r = ntnx.probe([fx.onpremInventory, fx.nc2Inventory, fx.nc2Bill]);
    expect(r.results.deploymentType).toBe('undetermined');
    expect(r.results.conflicts.length).toBeGreaterThan(0);
  });
  it('flags NC2 host charges in the host cloud bill as a double-count suspect', () => {
    const r = ntnx.probe([fx.nc2Inventory, fx.nc2Bill]);
    expect(r.results.doubleCount.suspected).toBe(true);
    expect(r.results.doubleCount.overlapLineIds).toEqual(['L1']);
    expect(r.results.doubleCount.amountsByCurrency).toEqual({ USD: 120.5 });
    expect(ntnx.probe([fx.onpremInventory, fx.plainBill]).results.doubleCount.suspected).toBe(false);
    expect(ntnx.probe([fx.nc2Bill]).results.doubleCount.suspected).toBe(false);
  });
  it('never sums across currencies', () => {
    const line = (lineId: string, billedCost: number, billingCurrency: string) => ({ lineId, serviceName: 'NC2 host', description: '', billedCost, billingCurrency });
    const bill = { id: 'b', kind: 'cloud_bill_lines', hostProvider: 'aws', lines: [line('L1', 120.5, 'USD'), line('L9', 5, 'EUR')] } as const;
    expect(ntnx.probe([fx.nc2Inventory, bill]).results.doubleCount.amountsByCurrency).toEqual({ USD: 120.5, EUR: 5 });
  });
  it('does not mutate frozen input', () => {
    const input = Object.freeze([fx.nc2Inventory, fx.nc2Bill]);
    const before = JSON.stringify(input);
    ntnx.probe(input);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('catalog is labeled illustrative and says unknown where unknown', () => {
    expect(costEvidenceCatalog.illustrative).toBe(true);
    expect(costEvidenceCatalog.byType.undetermined.every((e) => e.existence === 'unknown')).toBe(true);
    expect(costEvidenceCatalog.byType.nc2_on_public_cloud.length).toBeGreaterThan(0);
  });
});

describe('ServiceNowRoleProbe', () => {
  it('reports presence from rows, with authority unknown for every class', () => {
    const r = sn.probe(fx.snCmdbOnly);
    expect(r.results.findings).toHaveLength(4);
    expect(r.results.findings.every((f) => f.authority === 'unknown')).toBe(true);
    expect(cls(r, 'service_ci_mapping').presence).toBe('present');
  });
  it('never assumes cost data: CMDB and a cost-named plugin do not make cost present', () => {
    const r = sn.probe(fx.snCmdbOnly);
    expect(cls(r, 'cost_records').presence).toBe('absent');
    expect(cls(r, 'project_demand').presence).toBe('absent');
    expect(sn.probe([]).results.findings.every((f) => f.presence === 'unknown')).toBe(true);
    const pluginOnly = sn.probe([{ id: 'p', kind: 'plugin_list', plugins: [{ id: 'cost-management-module', active: true }] }]);
    expect(cls(pluginOnly, 'cost_records').presence).toBe('unknown');
  });
  it('reports cost present only from a cost table with rows or samples, still authority unknown', () => {
    const r = sn.probe(fx.snWithCostTable);
    expect(cls(r, 'cost_records').presence).toBe('present');
    expect(cls(r, 'cost_records').authority).toBe('unknown');
    expect(cls(r, 'license_asset').presence).toBe('unknown');
  });
  it('refuses to emit cost rows until a human confirms the cost-bearing role', () => {
    const f = cls(sn.probe(fx.snWithCostTable), 'cost_records');
    const rows = [{ amount: 1 }];
    expect(() => emitCostRows(f, rows)).toThrow(RoleNotConfirmedError);
    expect(() => emitCostRows(withHumanDecision(f, { decision: 'not_cost_bearing', decidedBy: 'owner' }), rows)).toThrow(RoleNotConfirmedError);
    expect(() => withHumanDecision(f, { decision: 'cost_bearing', decidedBy: ' ' })).toThrow();
    expect(emitCostRows(withHumanDecision(f, { decision: 'cost_bearing', decidedBy: 'owner' }), rows)).toEqual(rows);
    const absent = cls(sn.probe(fx.snCmdbOnly), 'cost_records');
    expect(() => emitCostRows(withHumanDecision(absent, { decision: 'cost_bearing', decidedBy: 'owner' }), rows)).toThrow(RoleNotConfirmedError);
  });
});
