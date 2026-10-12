import { describe, it, expect } from 'vitest';
import { buildReport, assertReport, MATURITY_CEILING } from './report';
import { toNanos, fmtNanos, normCurrency } from './money';
import { createNutanixEvidenceProbe, costEvidenceCatalog, type NutanixArtifact } from './nutanix/probe';
import { createServiceNowRoleProbe, emitCostRows, withHumanDecision, RoleNotConfirmedError, type ServiceNowArtifact, type RoleFinding } from './servicenow/probe';
import * as fx from './fixtures';

const ntnx = createNutanixEvidenceProbe();
const sn = createServiceNowRoleProbe();
const type = (a: NutanixArtifact[]) => ntnx.probe(a).results;
const undetermined = (a: NutanixArtifact[]) => {
  const r = type(a);
  expect(r.deploymentType).toBe('undetermined');
  expect(r.confidence).toBe('none');
  return r;
};
const cls = (a: readonly ServiceNowArtifact[], c: string): RoleFinding => sn.probe('src-a', a).results.findings.find((f) => f.recordClass === c)!;
const bill = (id: string, source: string, lines: object[]) => ({ id, source, kind: 'cloud_bill_lines', hostProvider: 'aws', lines }) as unknown as NutanixArtifact;
const inv = (id: string, source: string, clusters: object[], kind = 'cluster_export') => ({ id, source, kind, managementPlane: 'prism_central', clusters }) as unknown as NutanixArtifact;
const L = (lineId: string, billedCost: number | string, billingCurrency = 'USD', serviceName = 'Nutanix Cloud Clusters (NC2)') => ({ lineId, serviceName, billedCost, billingCurrency });

describe('EvidenceReport', () => {
  it('has placeholders and the ceiling is simulated', () => {
    const r = ntnx.probe([]);
    expect(MATURITY_CEILING).toBe('simulated');
    expect(r.revision).toMatch(/placeholder/i);
    expect(r.env).toMatch(/placeholder/i);
    expect(r.maturity).toBe('simulated');
    assertReport(r);
  });
  it('only allow-listed maturity up to simulated is accepted', () => {
    const mk = (maturity: unknown) => () => buildReport({ harness: 'x', commands: [], inputs: [], results: {}, limitations: [], maturity: maturity as never });
    for (const m of ['integration-tested', 'customer-validated', 'bogus', 'constructor', '__proto__', 'Customer-Validated', '', 7]) expect(mk(m)).toThrow();
    expect(mk('implemented')).not.toThrow();
  });
  it('hand-built literals fail assertReport; built reports are deeply frozen', () => {
    const lit = { harness: 'x', revision: 'r', env: 'e', commands: [], inputs: [], results: {}, limitations: [], maturity: 'simulated' };
    expect(() => assertReport(lit as never)).toThrow();
    const r = sn.probe('src-a', fx.snCmdbOnly);
    expect(() => assertReport({ ...r, maturity: 'customer-validated' } as never)).toThrow();
    expect(() => { (r.results.findings[0] as { presence: string }).presence = 'present'; }).toThrow(TypeError);
    expect(() => { (r as { maturity: string }).maturity = 'customer-validated'; }).toThrow(TypeError);
  });
});

describe('money', () => {
  it('parses exact decimals and rejects junk', () => {
    expect(fmtNanos(toNanos('0.1')! + toNanos('0.2')!)).toBe('0.3');
    expect(fmtNanos(toNanos(-5.25)!)).toBe('-5.25');
    for (const bad of [NaN, Infinity, 1e21, 1e-7, '1e3', '1.1234567891', 'abc', '12abc', '', ' 1', '0x10', null, {}, 0.1 + 0.2]) expect(toNanos(bad)).toBeNull();
    expect(toNanos('1.123456789')).not.toBeNull();
  });
  it('normalizes and validates currency codes', () => {
    expect(normCurrency(' usd ')).toBe('USD');
    for (const bad of ['__proto__', 'constructor', 'US', 'USDX', '', 5]) expect(normCurrency(bad)).toBeNull();
  });
});

describe('NutanixEvidenceProbe: independence (H1)', () => {
  it('defaults to undetermined and lists what is missing', () => {
    expect(undetermined([]).evidenceMissing).toEqual(expect.arrayContaining(['cluster_export', 'prism_inventory', 'cloud_bill_lines', 'cost_governance_export', 'onprem_cost_evidence']));
  });
  it('one artifact never classifies', () => {
    for (const a of [fx.nc2Inventory, fx.onpremInventory, fx.governanceExport, fx.nc2Bill]) undetermined([a]);
  });
  it.each([
    ['a copy of one inventory under a new id and source', [fx.nc2Inventory, { ...fx.nc2Inventory, id: 'copy', source: 'other' } as NutanixArtifact]],
    ['an inventory plus an export of the same cluster', [fx.nc2Inventory, fx.nc2Export]],
    ['same source and kind with different content', [fx.onpremInventory, { ...fx.onpremInventory, id: 'z', clusters: [{ name: 'c2', hypervisor: 'AHV', hostingProvider: 'on_prem' }] } as NutanixArtifact]],
    ['two governance exports', [fx.governanceExport, { ...fx.governanceExport, id: 'g2', source: 'tenant-b', rowCount: 5 } as NutanixArtifact]],
    ['two bills with NC2 lines and no cluster evidence', [fx.nc2Bill, bill('b2', 'cloud-bill-z', [L('Q1', 3)])]],
    ['an artifact without a source', [fx.nc2Inventory, { ...fx.nc2Bill, source: ' ' } as NutanixArtifact]],
  ])('%s is undetermined with evidence_not_independent', (_n, arts) => {
    expect(undetermined(arts).evidenceMissing).toContain('evidence_not_independent');
  });
  it('classifies independent corroboration and cites what it used', () => {
    const nc2 = type([fx.nc2Inventory, fx.nc2Bill]);
    expect(nc2.deploymentType).toBe('nc2_on_public_cloud');
    expect(nc2.confidence).toBe('medium');
    expect(nc2.evidenceUsed.map((e) => e.artifactId).sort()).toEqual(['bill-1', 'inv-1']);
    expect(type([fx.onpremInventory, fx.onpremCost]).deploymentType).toBe('onprem_ahv_prism');
    expect(type([fx.governanceExport, fx.governanceBill]).deploymentType).toBe('cost_governance_saas');
  });
  it('high confidence needs three distinct sources', () => {
    expect(type([fx.nc2Inventory, fx.nc2Export, fx.nc2Bill]).confidence).toBe('high');
    expect(type([fx.nc2Inventory, fx.nc2Bill]).confidence).toBe('medium');
  });
  it('a copy under a new source does not raise confidence', () => {
    const r = ntnx.probe([fx.nc2Inventory, { ...fx.nc2Inventory, id: 'copy', source: 'other' } as NutanixArtifact, fx.nc2Bill]).results;
    expect(r.confidence).toBe('medium');
    expect(r.duplicateArtifacts).toEqual([{ id: 'copy', reason: 'duplicate_content' }]);
  });
  it('on-prem needs AHV', () => {
    const esx = inv('e', 'pc-x', [{ name: 'c', hypervisor: 'ESXi', hostingProvider: 'on_prem' }], 'prism_inventory');
    undetermined([esx, fx.onpremCost]);
  });
  it('conflicting evidence is undetermined', () => {
    const r = undetermined([fx.onpremInventory, fx.nc2Inventory, fx.nc2Bill]);
    expect(r.conflicts.length).toBeGreaterThan(0);
  });
});

describe('NutanixEvidenceProbe: structured matching (H2, H3, M5)', () => {
  const noise = [
    { ...L('N1', 5, 'USD', 'Object storage'), description: 'bucket nc2-backup-logs', tags: { team: 'team-nc2' } },
    { ...L('N2', 5, 'USD', 'nc2-backup'), productCode: 'x' },
    { ...L('N3', 5, 'USD', 'Support'), productCode: 'Nutanix', description: 'Beam of light cost governance' },
  ];
  it('free text, tags and loose substrings never classify or flag double-count', () => {
    const r = undetermined([fx.nc2Inventory, bill('nb', 'cloud-bill-n', noise)]);
    expect(r.doubleCount.suspected).toBe(false);
    expect(r.doubleCount.overlapLineIds).toEqual([]);
    undetermined([fx.governanceExport, bill('nb2', 'cloud-bill-n', noise)]);
  });
  it('matches allow-listed values after whitespace and case normalization', () => {
    const r = type([fx.nc2Inventory, bill('b', 'cb', [L('M1', 1, 'USD', '  NUTANIX   cloud clusters (nc2) ')])]);
    expect(r.deploymentType).toBe('nc2_on_public_cloud');
  });
  it('unlisted hosting values are unknown, never public cloud', () => {
    for (const hp of ['datacenter', 'my-colo', 'Azure Stack', undefined]) {
      const r = undetermined([inv('i', 'pc', [{ name: 'c', hypervisor: 'AHV', hostingProvider: hp }]), fx.nc2Bill]);
      expect(r.evidenceMissing).toContain('cluster hosting location');
    }
    const upper = type([inv('i', 'pc', [{ name: 'c', hypervisor: 'AHV', hostingProvider: ' ON_PREM ' }]), fx.onpremCost]);
    expect(upper.deploymentType).toBe('onprem_ahv_prism');
  });
  it('one artifact with on-prem and cloud clusters reports coexisting types', () => {
    const mixed = inv('m', 'pc-m', [{ name: 'a', hypervisor: 'AHV', hostingProvider: 'on_prem' }, { name: 'b', hypervisor: 'AHV', hostingProvider: 'aws' }]);
    const r = undetermined([mixed, fx.nc2Bill]);
    expect(r.conflicts.join(' ')).toContain('coexisting_types');
    expect(r.evidenceUsed.map((e) => e.supports)).toEqual(expect.arrayContaining(['nc2_on_public_cloud', 'onprem_ahv_prism']));
  });
});

describe('NutanixEvidenceProbe: double count and money (M2 to M4)', () => {
  it('flags NC2 host charges in the host bill, exactly, per currency', () => {
    const dc = type([fx.nc2Inventory, fx.nc2Bill]).doubleCount;
    expect(dc.suspected).toBe(true);
    expect(dc.overlapLineIds).toEqual(['L1']);
    expect(dc.amounts.USD).toEqual({ gross: '120.5', credits: '0', net: '120.5' });
    expect(type([fx.onpremInventory, fx.plainBill]).doubleCount.suspected).toBe(false);
    expect(type([fx.nc2Bill]).doubleCount.suspected).toBe(false);
  });
  it('sums exactly, separates credits, never crosses currencies, normalizes codes', () => {
    const b = bill('b', 'cb', [L('A', '0.1'), L('B', '0.2'), L('C', -0.05), L('D', 5, 'eur'), L('E', 1, 'USD')]);
    const dc = type([fx.nc2Inventory, b]).doubleCount;
    expect(dc.amounts.USD).toEqual({ gross: '1.3', credits: '-0.05', net: '1.25' });
    expect(dc.amounts.EUR.net).toBe('5');
  });
  it('rejects invalid lines and reports duplicates once', () => {
    const b = bill('b', 'cb', [L('A', 1), L('A', 1), L('B', NaN), L('C', 1, '__proto__'), L('D', '1e3'), L('', 1)]);
    const dc = type([fx.nc2Inventory, b, bill('b2', 'cb2', [L('A', 1)])]).doubleCount;
    expect(dc.amounts.USD.net).toBe('1');
    expect(dc.duplicateLines).toEqual(['A', 'A']);
    expect(dc.invalidLines).toEqual(['B', 'C', 'D', '']);
  });
  it('compares against Nutanix-side amounts explicitly', () => {
    const withCost = (amount: string, currency = 'USD') => inv('i', 'pc', [{ name: 'c', hypervisor: 'AHV', hostingProvider: 'aws', reportedCost: { amount, currency } }], 'prism_inventory');
    const cmp = (amount: string, currency?: string) => type([withCost(amount, currency), fx.nc2Bill]).doubleCount.comparison.USD;
    expect(cmp('120.5')).toBe('equal');
    expect(cmp('120')).toBe('near');
    expect(cmp('50')).toBe('different');
    expect(cmp('50', 'EUR')).toBe('not_comparable');
    expect(type([fx.nc2Inventory, fx.nc2Bill]).doubleCount.comparison.USD).toBe('not_comparable');
  });
  it('handles a 250k-line bill', () => {
    const lines = Array.from({ length: 250_000 }, (_v, i) => L(`X${i}`, '0.01'));
    const dc = type([fx.nc2Inventory, bill('big', 'cb', lines)]).doubleCount;
    expect(dc.overlapLineIds).toHaveLength(250_000);
    expect(dc.amounts.USD.net).toBe('2500');
  });
  it('does not mutate frozen input; catalog is illustrative', () => {
    const input = Object.freeze([fx.nc2Inventory, fx.nc2Bill]);
    const before = JSON.stringify(input);
    ntnx.probe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(costEvidenceCatalog.illustrative).toBe(true);
    expect(costEvidenceCatalog.byType.undetermined.every((e) => e.existence === 'unknown')).toBe(true);
  });
});

describe('ServiceNowRoleProbe', () => {
  it('reports presence, authority unknown, never assumes cost', () => {
    const r = sn.probe('src-a', fx.snCmdbOnly);
    expect(r.results.findings).toHaveLength(4);
    expect(r.results.findings.every((f) => f.authority === 'unknown' && f.sourceId === 'src-a')).toBe(true);
    expect(cls(fx.snCmdbOnly, 'service_ci_mapping').presence).toBe('present');
    expect(cls(fx.snCmdbOnly, 'cost_records').presence).toBe('absent');
    expect(sn.probe('src-a', []).results.findings.every((f) => f.presence === 'unknown')).toBe(true);
    const pluginOnly: ServiceNowArtifact[] = [{ id: 'p', kind: 'plugin_list', plugins: [{ id: 'cost-management-module', active: true }] }];
    expect(cls(pluginOnly, 'cost_records').presence).toBe('unknown');
    expect(() => sn.probe(' ', [])).toThrow();
  });
  it('cost present only from a cost table with rows or valid samples', () => {
    expect(cls(fx.snWithCostTable, 'cost_records').presence).toBe('present');
    expect(cls(fx.snWithCostTable, 'license_asset').presence).toBe('unknown');
  });
  it('validates row counts, samples, casing, and conflicts (M6)', () => {
    const inventory = (rowCount: unknown, complete = false): ServiceNowArtifact[] => [{ id: 't', kind: 'table_inventory', complete, tables: [{ name: 'FM_Expense_Line ', rowCount: rowCount as number }] }];
    for (const bad of ['3', NaN, 1e308, -1, 1.5, Infinity]) expect(cls(inventory(bad), 'cost_records').presence).toBe('unknown');
    expect(cls(inventory(3), 'cost_records').presence).toBe('present');
    expect(cls(inventory(undefined, true), 'cost_records').presence).toBe('unknown');
    expect(cls(inventory(0, true), 'cost_records').presence).toBe('absent');
    const sample = (records: unknown): ServiceNowArtifact[] => [{ id: 's', kind: 'sample_records', table: 'fm_expense_line', records: records as never }];
    for (const bad of [[], [{}], [null], [[1]], [{ amount: 1 }], 'rows', [{ amount: 1, currency: 'USD' }, {}]]) expect(cls(sample(bad), 'cost_records').presence).toBe('unknown');
    expect(cls(sample([{ amount: 1, currency: 'USD' }]), 'cost_records').presence).toBe('present');
    const conflict = cls([...sample([{ amount: 1, currency: 'USD' }]), { id: 'c', kind: 'table_inventory', complete: true, tables: [{ name: 'cmdb_ci', rowCount: 1 }] }], 'cost_records');
    expect(conflict.presence).toBe('conflict');
    expect(conflict.conflicts.length).toBeGreaterThan(0);
  });
});

describe('emitCostRows (H4)', () => {
  const rows = [{ amount: 1 }];
  const f = () => cls(fx.snWithCostTable, 'cost_records');
  const ok = { decision: 'cost_bearing' as const, decidedBy: ' owner ' };
  it('refuses without a human decision or with not_cost_bearing', () => {
    expect(() => emitCostRows(f(), rows, 'src-a')).toThrow(RoleNotConfirmedError);
    expect(() => emitCostRows(withHumanDecision(f(), { decision: 'not_cost_bearing', decidedBy: 'owner' }), rows, 'src-a')).toThrow(RoleNotConfirmedError);
  });
  it('emits only for a branded, bound, cost-bearing decision', () => {
    const d = withHumanDecision(f(), ok);
    expect(emitCostRows(d, rows, 'src-a')).toEqual(rows);
    expect((d.authority as { decidedBy: string }).decidedBy).toBe('owner');
    expect(() => emitCostRows(d, rows, 'src-b')).toThrow(RoleNotConfirmedError);
  });
  it.each([[''], [' '], [undefined], [7]])('rejects decidedBy %j', (decidedBy) => {
    expect(() => withHumanDecision(f(), { decision: 'cost_bearing', decidedBy: decidedBy as never })).toThrow();
  });
  it('rejects forged, cloned, spread, literal, and mutated findings', () => {
    const d = withHumanDecision(f(), ok);
    const forged = { ...f(), authority: { decision: 'cost_bearing', decidedBy: 'x', sourceId: 'src-a', recordClass: 'cost_records' } };
    const cloned = structuredClone(d);
    const literal = { recordClass: 'cost_records', sourceId: 'src-a', presence: 'present', evidence: [], conflicts: [], authority: { decision: 'cost_bearing', decidedBy: 'x', sourceId: 'src-a', recordClass: 'cost_records' } };
    for (const bad of [forged, cloned, { ...d }, literal]) expect(() => emitCostRows(bad as never, rows, 'src-a')).toThrow(RoleNotConfirmedError);
    expect(() => { (f() as { authority: unknown }).authority = ok; }).toThrow(TypeError);
    expect(() => { (d.authority as { decision: string }).decision = 'x'; }).toThrow(TypeError);
  });
  it('rejects non-cost classes, absent records, and a second decision', () => {
    const svc = withHumanDecision(cls(fx.snCmdbOnly, 'service_ci_mapping'), ok);
    expect(() => emitCostRows(svc, rows, 'src-a')).toThrow(RoleNotConfirmedError);
    const absent = withHumanDecision(cls(fx.snCmdbOnly, 'cost_records'), ok);
    expect(() => emitCostRows(absent, rows, 'src-a')).toThrow(RoleNotConfirmedError);
    expect(() => withHumanDecision(withHumanDecision(f(), ok), { decision: 'not_cost_bearing', decidedBy: 'o' })).toThrow();
    expect(() => withHumanDecision({ ...f() }, ok)).toThrow();
  });
});
