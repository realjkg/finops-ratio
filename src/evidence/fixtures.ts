// SYNTHETIC evidence fixtures for the discovery harnesses. Every value is
// invented; none describes a real estate, customer, or instance.
import type { NutanixArtifact } from './nutanix/probe';
import type { ServiceNowArtifact } from './servicenow/probe';

export const nc2Line = { lineId: 'L1', serviceName: 'Nutanix Cloud Clusters (NC2)', billedCost: 120.5, billingCurrency: 'USD' };
export const plainLine = { lineId: 'L2', serviceName: 'Object storage', billedCost: 9, billingCurrency: 'USD' };

export const nc2Inventory: NutanixArtifact = { id: 'inv-1', source: 'prism-central-a', kind: 'prism_inventory', managementPlane: 'prism_central', clusters: [{ name: 'c-cloud', hypervisor: 'AHV', hostCount: 3, hostingProvider: 'aws' }] };
export const nc2Export: NutanixArtifact = { id: 'exp-1', source: 'export-tool-a', kind: 'cluster_export', clusters: [{ name: 'c-cloud', hypervisor: 'AHV', hostingProvider: 'aws' }] };
export const nc2Bill: NutanixArtifact = { id: 'bill-1', source: 'cloud-bill-a', kind: 'cloud_bill_lines', hostProvider: 'aws', lines: [nc2Line, plainLine] };
export const onpremInventory: NutanixArtifact = { id: 'inv-2', source: 'prism-central-b', kind: 'prism_inventory', managementPlane: 'prism_central', clusters: [{ name: 'c-dc', hypervisor: 'AHV', hostCount: 4, hostingProvider: 'on_prem' }] };
export const onpremCost: NutanixArtifact = { id: 'cost-2', source: 'finance-ledger-b', kind: 'onprem_cost_evidence', evidenceType: 'depreciation_schedule', rowCount: 4 };
export const plainBill: NutanixArtifact = { id: 'bill-2', source: 'cloud-bill-b', kind: 'cloud_bill_lines', hostProvider: 'aws', lines: [plainLine] };
export const governanceExport: NutanixArtifact = { id: 'gov-1', source: 'governance-tenant-a', kind: 'cost_governance_export', rowCount: 12 };
export const governanceBill: NutanixArtifact = { id: 'bill-3', source: 'cloud-bill-c', kind: 'cloud_bill_lines', hostProvider: 'azure', lines: [{ lineId: 'L3', serviceName: 'Nutanix Cost Governance', billedCost: 40, billingCurrency: 'EUR' }] };

export const snCmdbOnly: ServiceNowArtifact[] = [
  { id: 'tbl-1', kind: 'table_inventory', complete: true, tables: [{ name: 'cmdb_ci', rowCount: 500 }, { name: 'cmdb_ci_service', rowCount: 20 }, { name: 'incident', rowCount: 9 }] },
  { id: 'plug-1', kind: 'plugin_list', plugins: [{ id: 'cost-management-module', active: true }] },
];
export const snWithCostTable: ServiceNowArtifact[] = [
  { id: 'tbl-2', kind: 'table_inventory', complete: false, tables: [{ name: 'fm_expense_line', rowCount: 3 }] },
  { id: 'smp-1', kind: 'sample_records', table: 'fm_expense_line', records: [{ amount: 10, currency: 'USD' }] },
];
