// Kubernetes cost apportionment: node and cluster cost split to namespaces (or
// a label's values) by request, usage or the larger of the two, with idle
// capacity and system overhead as explicit lines, and shared-cluster costs
// split by a chosen policy. Pure, deterministic, integer arithmetic (BigInt).
//
// Trust boundary: the request is untrusted (it will come from a metrics export).
// It is validated whole and refused with a fixed-text AllocationError on any
// problem: caps on nodes, workloads, shared costs, groups, labels; strict
// decimals and integers; DNS-1123 namespace names; one currency for the whole
// apportionment; one declared unit per resource. Quantities are bare integers:
// CPU in millicores, memory in MiB (1 MiB = 2^20 bytes). A quantity with a
// unit suffix ("500m", "2Gi", "1G") is refused as MIXED_UNITS, and so is a
// per-workload `units` field that differs from the declared units: the caller
// converts, this module never guesses between decimal and binary prefixes.
//
// How the node cost is split:
//   1. The total node cost N is split between CPU and memory by the explicit
//      `resourceWeights` percents (they must sum to exactly 100).
//   2. For each resource r, capacity C is the sum over nodes, reserved
//      (kubelet/system) capacity O is the sum of per-node reserved amounts, and
//      each workload's basis is its request, its usage, or max(request, usage)
//      (the max is taken PER WORKLOAD, then summed). Workloads in
//      `systemNamespaces` count as system overhead rather than as a group.
//   3. The pool for r is split by weights: one per group (its summed basis),
//      SYSTEM_OVERHEAD (O + system-namespace basis), and IDLE =
//      max(0, C - O - system basis - group basis). If the bases exceed the
//      capacity (overcommit), there is no idle and the pool is shared in
//      proportion to the bases.
//   4. Largest-remainder splitting makes the lines sum to N exactly.
// Idle and overhead are never redistributed silently; they stay explicit lines.
//
// Shared-cluster costs (control plane, load balancers, other) are split per
// category by a policy: `even` over the groups, `proportional` to each group's
// node cost, `fixedPercent` (sums to exactly 100) or `usageWeight`, both over
// named groups that must exist. Cost with nothing to follow (no groups, or all
// weights zero) becomes an explicit `unapportioned` line, never dropped.
//
// Defined refusals: total node cost of zero or less (NON_POSITIVE_TOTAL), a
// negative node or shared amount (NEGATIVE_AMOUNT), total CPU or memory
// capacity of zero (ZERO_CAPACITY), reserved above capacity (CAPACITY_EXCEEDED),
// mixed currencies (MIXED_CURRENCY). Defined successes: no workloads (all cost
// is idle), all-zero usage (all cost is idle), one namespace (it takes all
// workload cost), a zero shared total (no shared lines).

import { AllocationError } from './errors';
import { LIMITS, checkText, compareKeys, isPlainObject, own } from './limits';
import {
  PERCENT_TOTAL,
  ZERO,
  ONE,
  currencyExponent,
  formatMinor,
  parseDecimalScaled,
  parsePercent,
  parseUsageWeight,
  splitByKeys,
  splitLargestRemainder,
  sumBigInt,
  type KeyedWeight,
  type RoundingMode,
} from './money';
import { checkTenant } from './rows';

export type UsageBasis = 'request' | 'usage' | 'max';
export type SharedCategory = 'controlPlane' | 'loadBalancer' | 'other';
export type IntegerInput = string | number | bigint;

export const K8S_UNITS = Object.freeze({ cpu: 'millicores', memory: 'MiB' } as const);

/** Reserved group ids that user groups may not use. Namespaces cannot collide (DNS-1123 is lowercase). */
export const K8S_IDLE = 'IDLE';
export const K8S_SYSTEM_OVERHEAD = 'SYSTEM_OVERHEAD';
export const K8S_UNAPPORTIONED = 'UNAPPORTIONED';
export const K8S_UNLABELED = 'UNLABELED';
const RESERVED_GROUPS = new Set([K8S_IDLE, K8S_SYSTEM_OVERHEAD, K8S_UNAPPORTIONED, K8S_UNLABELED]);

export interface K8sNodeCost {
  id: string;
  /** Must equal the request currency: lines in different currencies are refused, never summed. */
  currency: string;
  /** Decimal cost of the node for the period. Not negative. */
  amount: string;
  cpuCapacityMillicores: IntegerInput;
  memoryCapacityMiB: IntegerInput;
  /** Capacity held back for the kubelet and system daemons. Defaults to 0. */
  cpuReservedMillicores?: IntegerInput;
  memoryReservedMiB?: IntegerInput;
}

export interface K8sSharedCost {
  id: string;
  /** Must equal the request currency. */
  currency: string;
  category: SharedCategory;
  amount: string;
}

export interface K8sWorkload {
  id: string;
  namespace: string;
  labels?: Record<string, string>;
  cpuRequestMillicores: IntegerInput;
  cpuUsageMillicores: IntegerInput;
  memoryRequestMiB: IntegerInput;
  memoryUsageMiB: IntegerInput;
  /** Optional per-record declaration; if present it must equal the request's units. */
  units?: { cpu: string; memory: string };
}

export type K8sSharedPolicy =
  | { kind: 'even' }
  | { kind: 'proportional' }
  | { kind: 'fixedPercent'; shares: Array<{ group: string; percent: string }> }
  | { kind: 'usageWeight'; weights: Array<{ group: string; weight: string }> };

export interface K8sRequest {
  tenant: string;
  clusterId: string;
  currency: string;
  units: { cpu: 'millicores'; memory: 'MiB' };
  nodes: K8sNodeCost[];
  sharedCosts?: K8sSharedCost[];
  workloads: K8sWorkload[];
  basis: UsageBasis;
  /** Percents that must sum to exactly 100, e.g. { cpu: '60', memory: '40' }. Zero is allowed for one side. */
  resourceWeights: { cpu: string; memory: string };
  /** Default: namespace. With a label, workloads lacking it fall in UNLABELED. */
  groupBy?: { kind: 'namespace' } | { kind: 'label'; key: string };
  /** Namespaces whose workloads count as system overhead (for example ['kube-system']). Default: none. */
  systemNamespaces?: string[];
  /** Default policy for every shared category. Required: the split is always an explicit choice. */
  sharedPolicy: K8sSharedPolicy;
  sharedPolicyByCategory?: Partial<Record<SharedCategory, K8sSharedPolicy>>;
  /** Amount rounding: 'refuse' (default) or 'half-even'. */
  rounding?: RoundingMode;
}

export interface K8sNodeLine {
  kind: 'workload' | 'idle' | 'systemOverhead';
  /** Group id for workload lines; null for idle and system overhead. */
  group: string | null;
  cpuMinor: bigint;
  memoryMinor: bigint;
  minor: bigint;
  amount: string;
}

export interface K8sSharedLine {
  kind: 'shared' | 'unapportioned';
  category: SharedCategory;
  /** Null for an unapportioned line. */
  group: string | null;
  minor: bigint;
  amount: string;
}

export interface K8sGroupTotal {
  group: string;
  nodeMinor: bigint;
  sharedMinor: bigint;
  totalMinor: bigint;
  total: string;
}

export interface K8sApportionment {
  tenant: string;
  clusterId: string;
  currency: string;
  nodeCostMinor: bigint;
  sharedCostMinor: bigint;
  nodeLines: readonly K8sNodeLine[];
  sharedLines: readonly K8sSharedLine[];
  groups: readonly K8sGroupTotal[];
  idleMinor: bigint;
  systemOverheadMinor: bigint;
  unapportionedMinor: bigint;
  /** Exact by construction and checked before returning. */
  reconciliation: {
    nodeCostMinor: bigint;
    nodeAllocatedMinor: bigint;
    sharedCostMinor: bigint;
    sharedAllocatedMinor: bigint;
    reconciled: true;
  };
}

// ---------------------------------------------------------------- parsing

const MAX_QUANTITY = BigInt('1000000000000000'); // 10^15 millicores or MiB
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL_KEY_RE = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,251}[A-Za-z0-9])?$/;
const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const SUFFIXED_RE = /^[0-9.]+[A-Za-z]+$/;
const CATEGORIES: readonly SharedCategory[] = ['controlPlane', 'loadBalancer', 'other'];

function bad(index?: number): AllocationError {
  return new AllocationError('INVALID_K8S_REQUEST', index);
}

function parseQuantity(v: unknown, index?: number): bigint {
  let q: bigint;
  if (typeof v === 'bigint') q = v;
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw bad(index);
    q = BigInt(v);
  } else if (typeof v === 'string') {
    if (SUFFIXED_RE.test(v)) throw new AllocationError('MIXED_UNITS', index);
    if (!/^[0-9]{1,16}$/.test(v)) throw bad(index);
    q = BigInt(v);
  } else throw bad(index);
  if (q < ZERO || q > MAX_QUANTITY) throw bad(index);
  return q;
}

function optionalQuantity(v: unknown, index?: number): bigint {
  return v === undefined ? ZERO : parseQuantity(v, index);
}

function listOf(v: unknown, max: number, code: 'TOO_MANY_ITEMS' = 'TOO_MANY_ITEMS'): unknown[] {
  if (!Array.isArray(v)) throw bad();
  if (v.length > max) throw new AllocationError(code);
  return v as unknown[];
}

function amountOf(text: unknown, currency: string, rounding: RoundingMode, index?: number): bigint {
  let value: bigint;
  try {
    value = parseDecimalScaled(text, currencyExponent(currency), rounding).value;
  } catch (e) {
    if (e instanceof AllocationError) throw new AllocationError(e.code, index);
    throw e;
  }
  if (value < ZERO) throw new AllocationError('NEGATIVE_AMOUNT', index);
  return value;
}

interface NodeParsed {
  amount: bigint;
  cpuCap: bigint;
  memCap: bigint;
  cpuReserved: bigint;
  memReserved: bigint;
}

interface WorkloadParsed {
  group: string | null; // null = system overhead
  cpuRequest: bigint;
  cpuUsage: bigint;
  memRequest: bigint;
  memUsage: bigint;
}

function basisOf(basis: UsageBasis, request: bigint, usage: bigint): bigint {
  if (basis === 'request') return request;
  if (basis === 'usage') return usage;
  return request > usage ? request : usage;
}

type SharedWeights = (groups: ReadonlyMap<string, bigint>) => KeyedWeight[];

/** Validates a shared policy and returns a function that turns group node-costs into split weights. */
function compileSharedPolicy(raw: unknown): SharedWeights {
  if (!isPlainObject(raw)) throw bad();
  const kind = own(raw, 'kind');
  if (kind === 'even' || kind === 'proportional') {
    for (const k of Object.keys(raw)) if (k !== 'kind') throw bad();
    if (kind === 'even') return (groups) => [...groups.keys()].map((key) => ({ key, weight: ONE }));
    return (groups) => [...groups].filter(([, cost]) => cost > ZERO).map(([key, cost]) => ({ key, weight: cost }));
  }
  if (kind === 'fixedPercent' || kind === 'usageWeight') {
    const listKey = kind === 'fixedPercent' ? 'shares' : 'weights';
    for (const k of Object.keys(raw)) if (k !== 'kind' && k !== listKey) throw bad();
    const items = listOf(own(raw, listKey), LIMITS.maxK8sShares);
    if (items.length === 0) throw bad();
    const seen = new Set<string>();
    const entries: KeyedWeight[] = items.map((it) => {
      if (!isPlainObject(it)) throw bad();
      for (const k of Object.keys(it)) if (k !== 'group' && k !== (kind === 'fixedPercent' ? 'percent' : 'weight')) throw bad();
      const group = checkText(own(it, 'group'), 63, 'INVALID_K8S_REQUEST');
      if (seen.has(group)) throw new AllocationError('DUPLICATE_KEY');
      seen.add(group);
      const weight = kind === 'fixedPercent' ? parsePercent(own(it, 'percent')) : parseUsageWeight(own(it, 'weight'));
      return { key: group, weight };
    });
    const total = sumBigInt(entries.map((e) => e.weight));
    if (kind === 'fixedPercent' && total !== PERCENT_TOTAL) throw new AllocationError('PERCENT_SUM_INVALID');
    if (kind === 'usageWeight' && total === ZERO) throw new AllocationError('ZERO_WEIGHT');
    return (groups) => {
      for (const e of entries) if (!groups.has(e.key)) throw new AllocationError('UNKNOWN_GROUP');
      return entries;
    };
  }
  throw bad();
}

// ---------------------------------------------------------------- apportionment

/**
 * Apportions a cluster's node and shared cost. See the module header for the
 * method and the defined refusals. Throws a fixed-text AllocationError on any
 * malformed or oversized input.
 */
export function apportionKubernetesCost(requestArg: K8sRequest): K8sApportionment {
  if (!isPlainObject(requestArg)) throw bad();
  const req = requestArg as unknown as Record<string, unknown>;
  const tenant = checkTenant(own(req, 'tenant'));
  const clusterId = checkText(own(req, 'clusterId'), LIMITS.maxIdLength, 'INVALID_K8S_REQUEST');
  const currencyRaw = own(req, 'currency');
  currencyExponent(currencyRaw);
  const currency = currencyRaw as string;
  const rounding = own(req, 'rounding') ?? 'refuse';
  if (rounding !== 'refuse' && rounding !== 'half-even') throw bad();

  // Units: declared once, exactly the supported pair.
  const units = own(req, 'units');
  if (!isPlainObject(units) || own(units, 'cpu') !== K8S_UNITS.cpu || own(units, 'memory') !== K8S_UNITS.memory) {
    throw new AllocationError('MIXED_UNITS');
  }
  const basisRaw = own(req, 'basis');
  if (basisRaw !== 'request' && basisRaw !== 'usage' && basisRaw !== 'max') throw bad();
  const basis: UsageBasis = basisRaw;

  const weights = own(req, 'resourceWeights');
  if (!isPlainObject(weights)) throw bad();
  const wCpu = parsePercent(own(weights, 'cpu'));
  const wMem = parsePercent(own(weights, 'memory'));
  if (wCpu + wMem !== PERCENT_TOTAL) throw new AllocationError('PERCENT_SUM_INVALID');

  const groupByRaw = own(req, 'groupBy') ?? { kind: 'namespace' };
  let labelKey: string | null = null;
  if (!isPlainObject(groupByRaw)) throw bad();
  const groupKind = own(groupByRaw, 'kind');
  if (groupKind === 'label') {
    for (const k of Object.keys(groupByRaw)) if (k !== 'kind' && k !== 'key') throw bad();
    const key = own(groupByRaw, 'key');
    if (typeof key !== 'string' || !LABEL_KEY_RE.test(key)) throw bad();
    labelKey = key;
  } else if (groupKind === 'namespace') {
    for (const k of Object.keys(groupByRaw)) if (k !== 'kind') throw bad();
  } else throw bad();

  const systemNamespaces = new Set<string>();
  const systemRaw = own(req, 'systemNamespaces');
  if (systemRaw !== undefined) {
    for (const ns of listOf(systemRaw, LIMITS.maxK8sShares)) {
      if (typeof ns !== 'string' || !DNS_LABEL_RE.test(ns)) throw bad();
      systemNamespaces.add(ns);
    }
  }

  // Shared policies are validated up front, used or not.
  const defaultShared = compileSharedPolicy(own(req, 'sharedPolicy'));
  const byCategoryRaw = own(req, 'sharedPolicyByCategory');
  const sharedByCategory = new Map<SharedCategory, SharedWeights>();
  if (byCategoryRaw !== undefined) {
    if (!isPlainObject(byCategoryRaw)) throw bad();
    for (const k of Object.keys(byCategoryRaw)) {
      if (!CATEGORIES.includes(k as SharedCategory)) throw bad();
      sharedByCategory.set(k as SharedCategory, compileSharedPolicy(own(byCategoryRaw, k)));
    }
  }

  // Nodes.
  const nodesRaw = listOf(own(req, 'nodes'), LIMITS.maxK8sNodes);
  if (nodesRaw.length === 0) throw new AllocationError('NON_POSITIVE_TOTAL');
  const nodeIds = new Set<string>();
  const nodes: NodeParsed[] = nodesRaw.map((n, i) => {
    if (!isPlainObject(n)) throw bad(i);
    const id = checkText(own(n, 'id'), LIMITS.maxIdLength, 'INVALID_K8S_REQUEST', {}, i);
    if (nodeIds.has(id)) throw bad(i);
    nodeIds.add(id);
    if (own(n, 'currency') !== currency) throw new AllocationError('MIXED_CURRENCY', i);
    const cpuCap = parseQuantity(own(n, 'cpuCapacityMillicores'), i);
    const memCap = parseQuantity(own(n, 'memoryCapacityMiB'), i);
    const cpuReserved = optionalQuantity(own(n, 'cpuReservedMillicores'), i);
    const memReserved = optionalQuantity(own(n, 'memoryReservedMiB'), i);
    if (cpuReserved > cpuCap || memReserved > memCap) throw new AllocationError('CAPACITY_EXCEEDED', i);
    return { amount: amountOf(own(n, 'amount'), currency, rounding, i), cpuCap, memCap, cpuReserved, memReserved };
  });
  const nodeTotal = sumBigInt(nodes.map((n) => n.amount));
  if (nodeTotal <= ZERO) throw new AllocationError('NON_POSITIVE_TOTAL');
  const capCpu = sumBigInt(nodes.map((n) => n.cpuCap));
  const capMem = sumBigInt(nodes.map((n) => n.memCap));
  if (capCpu <= ZERO || capMem <= ZERO) throw new AllocationError('ZERO_CAPACITY');
  const resCpu = sumBigInt(nodes.map((n) => n.cpuReserved));
  const resMem = sumBigInt(nodes.map((n) => n.memReserved));

  // Shared costs.
  const sharedRaw = listOf(own(req, 'sharedCosts') ?? [], LIMITS.maxK8sSharedCosts);
  const sharedIds = new Set<string>();
  const sharedByCat = new Map<SharedCategory, bigint>();
  let sharedTotal = ZERO;
  sharedRaw.forEach((s, i) => {
    if (!isPlainObject(s)) throw bad(i);
    const id = checkText(own(s, 'id'), LIMITS.maxIdLength, 'INVALID_K8S_REQUEST', {}, i);
    if (sharedIds.has(id)) throw bad(i);
    sharedIds.add(id);
    if (own(s, 'currency') !== currency) throw new AllocationError('MIXED_CURRENCY', i);
    const category = own(s, 'category');
    if (!CATEGORIES.includes(category as SharedCategory)) throw bad(i);
    const amount = amountOf(own(s, 'amount'), currency, rounding, i);
    sharedByCat.set(category as SharedCategory, (sharedByCat.get(category as SharedCategory) ?? ZERO) + amount);
    sharedTotal += amount;
  });

  // Workloads.
  const workloadsRaw = listOf(own(req, 'workloads'), LIMITS.maxK8sWorkloads);
  const workloadIds = new Set<string>();
  const parsed: WorkloadParsed[] = workloadsRaw.map((w, i) => {
    if (!isPlainObject(w)) throw bad(i);
    const id = checkText(own(w, 'id'), LIMITS.maxIdLength, 'INVALID_K8S_REQUEST', {}, i);
    if (workloadIds.has(id)) throw bad(i);
    workloadIds.add(id);
    const ns = own(w, 'namespace');
    if (typeof ns !== 'string' || !DNS_LABEL_RE.test(ns)) throw bad(i);
    const declared = own(w, 'units');
    if (declared !== undefined) {
      if (!isPlainObject(declared) || own(declared, 'cpu') !== K8S_UNITS.cpu || own(declared, 'memory') !== K8S_UNITS.memory) {
        throw new AllocationError('MIXED_UNITS', i);
      }
    }
    let group: string | null;
    if (systemNamespaces.has(ns)) group = null;
    else if (labelKey === null) group = ns;
    else {
      const labels = own(w, 'labels');
      if (labels === undefined) group = K8S_UNLABELED;
      else {
        if (!isPlainObject(labels) || Object.keys(labels).length > LIMITS.maxK8sLabels) throw bad(i);
        const v = own(labels, labelKey);
        if (v === undefined || v === '') group = K8S_UNLABELED;
        else {
          if (typeof v !== 'string' || !LABEL_VALUE_RE.test(v) || RESERVED_GROUPS.has(v)) throw bad(i);
          group = v;
        }
      }
    }
    return {
      group,
      cpuRequest: parseQuantity(own(w, 'cpuRequestMillicores'), i),
      cpuUsage: parseQuantity(own(w, 'cpuUsageMillicores'), i),
      memRequest: parseQuantity(own(w, 'memoryRequestMiB'), i),
      memUsage: parseQuantity(own(w, 'memoryUsageMiB'), i),
    };
  });

  // Group bases (the max is per workload, then summed).
  const cpuByGroup = new Map<string, bigint>();
  const memByGroup = new Map<string, bigint>();
  let sysCpu = ZERO;
  let sysMem = ZERO;
  for (const w of parsed) {
    const c = basisOf(basis, w.cpuRequest, w.cpuUsage);
    const m = basisOf(basis, w.memRequest, w.memUsage);
    if (w.group === null) {
      sysCpu += c;
      sysMem += m;
    } else {
      cpuByGroup.set(w.group, (cpuByGroup.get(w.group) ?? ZERO) + c);
      memByGroup.set(w.group, (memByGroup.get(w.group) ?? ZERO) + m);
    }
  }
  if (cpuByGroup.size > LIMITS.maxK8sGroups) throw new AllocationError('TOO_MANY_ITEMS');
  const groups = [...cpuByGroup.keys()].sort(compareKeys);

  // Step 1: CPU/memory pools from the explicit weights.
  const [nodeCpuPool, nodeMemPool] = splitLargestRemainder(nodeTotal, [wCpu, wMem]);

  // Step 2-3: split each pool over groups, system overhead and idle.
  const splitPool = (
    pool: bigint,
    capacity: bigint,
    reserved: bigint,
    systemBasis: bigint,
    byGroup: ReadonlyMap<string, bigint>,
  ): Map<string, bigint> => {
    const out = new Map<string, bigint>();
    if (pool === ZERO) {
      for (const g of groups) out.set(g, ZERO);
      out.set(K8S_SYSTEM_OVERHEAD, ZERO);
      out.set(K8S_IDLE, ZERO);
      return out;
    }
    const groupBasis = sumBigInt(byGroup.values());
    const used = reserved + systemBasis + groupBasis;
    const idle = capacity > used ? capacity - used : ZERO;
    const entries: KeyedWeight[] = groups.map((g) => ({ key: g, weight: byGroup.get(g) ?? ZERO }));
    entries.push({ key: K8S_SYSTEM_OVERHEAD, weight: reserved + systemBasis });
    entries.push({ key: K8S_IDLE, weight: idle });
    for (const s of splitByKeys(pool, entries)) out.set(s.key, s.minor);
    return out;
  };
  const cpuShares = splitPool(nodeCpuPool, capCpu, resCpu, sysCpu, cpuByGroup);
  const memShares = splitPool(nodeMemPool, capMem, resMem, sysMem, memByGroup);

  const mkNodeLine = (kind: K8sNodeLine['kind'], group: string | null, key: string): K8sNodeLine => {
    const cpuMinor = cpuShares.get(key) ?? ZERO;
    const memoryMinor = memShares.get(key) ?? ZERO;
    const minor = cpuMinor + memoryMinor;
    return Object.freeze({ kind, group, cpuMinor, memoryMinor, minor, amount: formatMinor(minor, currency) });
  };
  const nodeLines: K8sNodeLine[] = groups.map((g) => mkNodeLine('workload', g, g));
  nodeLines.push(mkNodeLine('systemOverhead', null, K8S_SYSTEM_OVERHEAD));
  nodeLines.push(mkNodeLine('idle', null, K8S_IDLE));

  // Shared costs per category.
  const groupNodeCost = new Map<string, bigint>();
  for (const l of nodeLines) if (l.kind === 'workload' && l.group !== null) groupNodeCost.set(l.group, l.minor);
  const sharedLines: K8sSharedLine[] = [];
  for (const category of CATEGORIES) {
    const total = sharedByCat.get(category) ?? ZERO;
    if (total === ZERO) continue;
    const weightsFor = sharedByCategory.get(category) ?? defaultShared;
    const entries = weightsFor(groupNodeCost).filter((e) => e.weight > ZERO);
    if (entries.length === 0) {
      sharedLines.push(
        Object.freeze({ kind: 'unapportioned' as const, category, group: null, minor: total, amount: formatMinor(total, currency) }),
      );
      continue;
    }
    for (const s of splitByKeys(total, entries)) {
      if (s.minor === ZERO) continue;
      sharedLines.push(
        Object.freeze({ kind: 'shared' as const, category, group: s.key, minor: s.minor, amount: formatMinor(s.minor, currency) }),
      );
    }
  }

  // Reconcile exactly, then summarize.
  const nodeAllocated = sumBigInt(nodeLines.map((l) => l.minor));
  const sharedAllocated = sumBigInt(sharedLines.map((l) => l.minor));
  if (nodeAllocated !== nodeTotal || sharedAllocated !== sharedTotal) throw new AllocationError('RECONCILIATION_FAILED');

  const sharedByGroup = new Map<string, bigint>();
  let unapportioned = ZERO;
  for (const l of sharedLines) {
    if (l.group === null) unapportioned += l.minor;
    else sharedByGroup.set(l.group, (sharedByGroup.get(l.group) ?? ZERO) + l.minor);
  }
  const groupTotals: K8sGroupTotal[] = [...new Set<string>([...groups, ...sharedByGroup.keys()])].sort(compareKeys).map((g) => {
    const nodeMinor = groupNodeCost.get(g) ?? ZERO;
    const sharedMinor = sharedByGroup.get(g) ?? ZERO;
    const totalMinor = nodeMinor + sharedMinor;
    return Object.freeze({ group: g, nodeMinor, sharedMinor, totalMinor, total: formatMinor(totalMinor, currency) });
  });
  const line = (kind: K8sNodeLine['kind']): bigint => nodeLines.find((l) => l.kind === kind)?.minor ?? ZERO;

  return Object.freeze({
    tenant,
    clusterId,
    currency,
    nodeCostMinor: nodeTotal,
    sharedCostMinor: sharedTotal,
    nodeLines: Object.freeze(nodeLines),
    sharedLines: Object.freeze(sharedLines),
    groups: Object.freeze(groupTotals),
    idleMinor: line('idle'),
    systemOverheadMinor: line('systemOverhead'),
    unapportionedMinor: unapportioned,
    reconciliation: Object.freeze({
      nodeCostMinor: nodeTotal,
      nodeAllocatedMinor: nodeAllocated,
      sharedCostMinor: sharedTotal,
      sharedAllocatedMinor: sharedAllocated,
      reconciled: true as const,
    }),
  });
}
