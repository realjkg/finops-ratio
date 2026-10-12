import { RAW_SRMD, type RawSrmd } from './simulatedFixture';
import { parseNanos } from './money';
import {
  SRMD_LABEL,
  type Capability,
  type CapabilityReport,
  type ControlTotal,
  type CostQuery,
  type Envelope,
  type SrmdAdapter,
  type SrmdCostRecord,
  type SrmdResult,
  type TagKey,
} from './types';
import { EFFECTIVE } from './simulatedFixture';

const STAMP: Envelope = { provenance: 'simulated', label: SRMD_LABEL, maturity: 'simulated' };
const UPSTREAM = 'srmd-simulated';

const CAPS: CapabilityReport['capabilities'] = {
  cost_records: { status: 'supported', reason: 'invented fixture records' },
  tags: { status: 'supported', reason: 'invented tag taxonomy' },
  account_mapping: { status: 'unknown', reason: 'no information about whether the real system maps accounts' },
  credits_refunds: { status: 'supported', reason: 'fixture holds a credit record' },
  shared_cost_allocation: { status: 'supported', reason: 'fixture holds a shared record with an unspecified rule' },
  migrations: { status: 'unsupported', reason: 'not modeled' },
  control_totals: { status: 'supported', reason: 'invented reported totals' },
  lineage_ids: { status: 'supported', reason: 'fixture carries lineage ids, some absent' },
};

function toRecord(r: RawSrmd): SrmdCostRecord {
  return {
    ...STAMP,
    kind: r.kind,
    provider: r.provider,
    billingAccountId: r.billingAccountId,
    billingPeriod: r.billingPeriod,
    currency: r.currency,
    amountNanos: parseNanos(r.amount),
    measure: { ...r.measure },
    tags: r.tags && { ...r.tags },
    lateArrival: !!r.late,
    shared: r.kind === 'shared' ? { allocatedTo: ['unit-a', 'unit-b'], rule: 'unspecified' } : null,
    lineage: {
      providerRecordId: r.providerRecordId,
      srmdRecordId: r.id,
      ratioRef: `ratio:${UPSTREAM}:${r.id}`,
      upstreamSystem: UPSTREAM,
      observedAt: r.late ? '2026-09-20T00:00:00Z' : '2026-09-02T00:00:00Z',
    },
  };
}

const ok = <T>(data: T): SrmdResult<T> => ({ ...STAMP, status: 'ok', data });
const unsupported = (capability: Capability): SrmdResult<never> => ({
  ...STAMP,
  status: 'unsupported',
  capability,
  reason: CAPS[capability].reason,
});

/** Simulated counterpart: every record and response says so. Every read builds fresh copies. */
export class SimulatedSrmdAdapter implements SrmdAdapter {
  readonly descriptor = { ...STAMP, id: UPSTREAM };

  async discoverCapabilities(): Promise<CapabilityReport> {
    return { ...STAMP, capabilities: structuredClone(CAPS) };
  }
  async listCostRecords(query: CostQuery = {}): Promise<SrmdResult<SrmdCostRecord[]>> {
    return ok(RAW_SRMD.filter((r) => !query.billingPeriod || r.billingPeriod === query.billingPeriod).map(toRecord));
  }
  async listTagTaxonomy(): Promise<SrmdResult<TagKey[]>> {
    return ok([{ key: 'cost_center', required: true }, { key: 'ratio:workload', required: false }]);
  }
  async listAccountMappings(): Promise<SrmdResult<never[]>> {
    return unsupported('account_mapping');
  }
  async listMigrations(): Promise<SrmdResult<never[]>> {
    return unsupported('migrations');
  }
  async getControlTotals(): Promise<SrmdResult<ControlTotal[]>> {
    return ok([
      { billingAccountId: 'acct-0001', billingPeriod: '2026-09', currency: 'USD', measure: { ...EFFECTIVE }, totalNanos: parseNanos('188.04') },
    ]);
  }
}
