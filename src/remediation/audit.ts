// Append-only, hash-chained audit log for remediation. One log per tenant.
//
// Trust boundary: records are built by this module's callers from fixed codes and validated
// ids, never from free text. Every field has a pattern and a cap; a record that does not fit
// is refused (the caller then refuses to act, so no effect happens without a record).
// Records hold no secrets: parameters are never copied in (only a short digest), detail keys
// that look secret-bearing are redacted, so are values that look like credentials, and long
// strings are truncated. Each record names the acting subject (a human `sub`, or the fixed
// service actor id for autonomy) and the policy version in force.
//
// Chain: hash = SHA-256(canonical JSON of the record without its hash), and the record holds
// the previous record's hash. `verifyChain` detects an edited record, a reordered pair, a
// removed record in the middle, and (given an externally anchored head) a truncated tail.
// A chain alone cannot prove the tail was not cut: anchor `head()` outside the process.
import { canonicalJson, sha256Hex } from './canonical';
import { ID_PATTERN } from './proposal';
import { LIMITS, RESERVED_ACTOR_PREFIX, SERVICE_ACTOR_ID } from './types';

export type AuditKind = 'proposal' | 'decision' | 'approval' | 'execution' | 'rollback' | 'kill_switch' | 'circuit_breaker';
export const AUDIT_KINDS: readonly AuditKind[] = Object.freeze(['proposal', 'decision', 'approval', 'execution', 'rollback', 'kill_switch', 'circuit_breaker'] as const);

export type AuditDetailInput = string | number | boolean | null | bigint;
type AuditDetail = string | number | boolean | null;

export interface AuditEntryInput {
  readonly at: number;
  readonly kind: AuditKind;
  /** A human `sub`, or SERVICE_ACTOR_ID. */
  readonly actor: string;
  readonly policyVersion: string;
  readonly proposalId?: string | null;
  readonly actionId?: string | null;
  /** A fixed code such as EXEC_OK. */
  readonly outcome: string;
  readonly detail?: Readonly<Record<string, AuditDetailInput>>;
}

export interface AuditRecord {
  readonly seq: number;
  readonly at: number;
  readonly tenant: string;
  readonly kind: AuditKind;
  readonly actor: string;
  readonly policyVersion: string;
  readonly proposalId: string | null;
  readonly actionId: string | null;
  readonly outcome: string;
  readonly detail: Readonly<Record<string, AuditDetail>>;
  readonly prevHash: string;
  readonly hash: string;
}

export type AppendResult =
  | { readonly ok: true; readonly record: AuditRecord }
  | { readonly ok: false; readonly code: 'AUDIT_FULL' | 'AUDIT_INVALID' | 'AUDIT_TOO_LARGE' };

export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

export interface AuditLog {
  readonly tenant: string;
  append(entry: AuditEntryInput): AppendResult;
  /** A copy of the records, each frozen. Mutating the copy never touches the log. */
  records(): readonly AuditRecord[];
  head(): AuditHead | null;
  /** How many more records fit before the cap. */
  remaining(): number;
}

export const GENESIS_HASH = '0'.repeat(64);

const ACTOR = /^[\x21-\x7E]{1,128}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OUTCOME = /^[A-Z][A-Z0-9_]{1,47}$/;
const ACTION_ID = /^[a-z][a-z0-9_]{1,47}$/;
const DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;
const SECRET_KEY = /(secret|passw|credential|authoriz|bearer|api_?key|private_?key|token|cookie)/i;
const SECRET_VALUE = /(bearer\s+\S|-----BEGIN [A-Z ]*PRIVATE KEY|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_-]{40,})/i;
const PRINTABLE = /^[\x20-\x7E]*$/;
const REDACTED = '[REDACTED]';

/** A usable actor id: the service actor, or a printable human sub that does not use the reserved prefix. */
export const isValidActor = (a: unknown): a is string =>
  typeof a === 'string' && (a === SERVICE_ACTOR_ID || (ACTOR.test(a) && !a.startsWith(RESERVED_ACTOR_PREFIX)));

type Body = Omit<AuditRecord, 'hash'>;

function cleanDetail(input: Readonly<Record<string, AuditDetailInput>> | undefined): Record<string, AuditDetail> | null {
  const out: Record<string, AuditDetail> = Object.create(null);
  if (input === undefined) return out;
  const keys = Object.keys(input);
  if (keys.length > LIMITS.maxAuditDetailKeys) return null;
  for (const k of keys) {
    if (!DETAIL_KEY.test(k)) return null;
    const v = input[k];
    if (SECRET_KEY.test(k)) {
      out[k] = REDACTED;
    } else if (typeof v === 'bigint') {
      out[k] = v.toString();
    } else if (typeof v === 'string') {
      if (!PRINTABLE.test(v)) return null;
      const t = v.length > LIMITS.maxAuditDetailValueLen ? v.slice(0, LIMITS.maxAuditDetailValueLen) : v;
      out[k] = SECRET_VALUE.test(t) ? REDACTED : t;
    } else if (typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (typeof v === 'number' && Number.isSafeInteger(v)) {
      out[k] = v;
    } else {
      return null;
    }
  }
  return out;
}

const hashOf = (body: Body): string => sha256Hex(canonicalJson(body));

/** Field-level validation shared by append and verifyChain. Returns the typed body or null. */
function readBody(o: Record<string, unknown>): Body | null {
  const { seq, at, tenant, kind, actor, policyVersion, proposalId, actionId, outcome, detail, prevHash } = o;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || !Number.isSafeInteger(at) || (at as number) < 0) return null;
  if (typeof tenant !== 'string' || !ID_PATTERN.test(tenant)) return null;
  if (typeof kind !== 'string' || !AUDIT_KINDS.includes(kind as AuditKind)) return null;
  if (!isValidActor(actor)) return null;
  if (typeof policyVersion !== 'string' || !VERSION.test(policyVersion)) return null;
  if (proposalId !== null && (typeof proposalId !== 'string' || !ID_PATTERN.test(proposalId))) return null;
  if (actionId !== null && (typeof actionId !== 'string' || !ACTION_ID.test(actionId))) return null;
  if (typeof outcome !== 'string' || !OUTCOME.test(outcome)) return null;
  if (typeof prevHash !== 'string' || !HASH.test(prevHash)) return null;
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const keys = Object.keys(d);
  if (keys.length > LIMITS.maxAuditDetailKeys) return null;
  const clean: Record<string, AuditDetail> = {};
  for (const k of keys) {
    const v = d[k];
    if (!DETAIL_KEY.test(k) || !(typeof v === 'string' || typeof v === 'boolean' || v === null || Number.isSafeInteger(v))) return null;
    if (typeof v === 'string' && (v.length > LIMITS.maxAuditDetailValueLen || !PRINTABLE.test(v))) return null;
    clean[k] = v as AuditDetail;
  }
  return {
    seq: seq as number, at: at as number, tenant, kind: kind as AuditKind, actor, policyVersion,
    proposalId: proposalId as string | null, actionId: actionId as string | null, outcome, detail: clean, prevHash,
  };
}

const sizeOk = (b: Body, hash: string): boolean => canonicalJson({ ...b, hash }).length <= LIMITS.maxAuditRecordBytes;

export function createAuditLog(tenant: string, opts: { maxRecords?: number } = {}): AuditLog {
  if (typeof tenant !== 'string' || !ID_PATTERN.test(tenant)) throw new Error('Invalid tenant');
  const max = opts.maxRecords !== undefined && Number.isSafeInteger(opts.maxRecords) && opts.maxRecords >= 1 && opts.maxRecords <= LIMITS.maxAuditRecords
    ? opts.maxRecords : LIMITS.maxAuditRecords;
  const log: AuditRecord[] = [];
  let lastHash = GENESIS_HASH;

  return Object.freeze({
    tenant,
    append(entry: AuditEntryInput): AppendResult {
      try {
        if (log.length >= max) return { ok: false, code: 'AUDIT_FULL' };
        const detail = cleanDetail(entry.detail);
        if (!detail) return { ok: false, code: 'AUDIT_INVALID' };
        const body = readBody({
          seq: log.length, at: entry.at, tenant, kind: entry.kind, actor: entry.actor, policyVersion: entry.policyVersion,
          proposalId: entry.proposalId ?? null, actionId: entry.actionId ?? null, outcome: entry.outcome, detail, prevHash: lastHash,
        });
        if (!body) return { ok: false, code: 'AUDIT_INVALID' };
        const hash = hashOf(body);
        if (!sizeOk(body, hash)) return { ok: false, code: 'AUDIT_TOO_LARGE' };
        const record: AuditRecord = Object.freeze({ ...body, detail: Object.freeze(body.detail), hash });
        log.push(record);
        lastHash = hash;
        return { ok: true, record };
      } catch {
        return { ok: false, code: 'AUDIT_INVALID' };
      }
    },
    records: () => Object.freeze(log.slice()),
    head: () => (log.length === 0 ? null : { seq: log.length - 1, hash: lastHash }),
    remaining: () => max - log.length,
  });
}

export type ChainErrorCode =
  | 'CHAIN_BAD_RECORD' | 'CHAIN_BAD_SEQ' | 'CHAIN_BAD_LINK' | 'CHAIN_BAD_HASH' | 'CHAIN_TENANT' | 'CHAIN_TOO_LONG' | 'CHAIN_TRUNCATED';

export type ChainResult =
  | { readonly ok: true; readonly length: number; readonly head: AuditHead | null }
  | { readonly ok: false; readonly code: ChainErrorCode; /** Index of the first bad record (or of the expected head for a truncation). */ readonly index: number };

const RECORD_KEYS = ['seq', 'at', 'tenant', 'kind', 'actor', 'policyVersion', 'proposalId', 'actionId', 'outcome', 'detail', 'prevHash', 'hash'];

/**
 * Verify a chain from genesis. Pass `tenant` to require every record to belong to it, and
 * `expectedHead` (anchored outside this process) to detect a truncated tail. Never throws.
 */
export function verifyChain(records: unknown, opts: { tenant?: string; expectedHead?: AuditHead } = {}): ChainResult {
  try {
    if (!Array.isArray(records)) return { ok: false, code: 'CHAIN_BAD_RECORD', index: 0 };
    const n = records.length;
    if (n > LIMITS.maxAuditRecords) return { ok: false, code: 'CHAIN_TOO_LONG', index: 0 };
    let prev = GENESIS_HASH;
    let tenant: string | null = opts.tenant ?? null;
    for (let i = 0; i < n; i += 1) {
      const raw: unknown = records[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'CHAIN_BAD_RECORD', index: i };
      const o = raw as Record<string, unknown>;
      const names = Object.getOwnPropertyNames(o);
      if (names.length !== RECORD_KEYS.length || !RECORD_KEYS.every((k) => names.includes(k))) return { ok: false, code: 'CHAIN_BAD_RECORD', index: i };
      const body = readBody(o);
      if (!body || typeof o.hash !== 'string' || !HASH.test(o.hash)) return { ok: false, code: 'CHAIN_BAD_RECORD', index: i };
      if (tenant === null) tenant = body.tenant;
      if (body.tenant !== tenant) return { ok: false, code: 'CHAIN_TENANT', index: i };
      if (body.seq !== i) return { ok: false, code: 'CHAIN_BAD_SEQ', index: i };
      if (body.prevHash !== prev) return { ok: false, code: 'CHAIN_BAD_LINK', index: i };
      if (hashOf(body) !== o.hash || !sizeOk(body, o.hash)) return { ok: false, code: 'CHAIN_BAD_HASH', index: i };
      prev = o.hash;
    }
    const head: AuditHead | null = n === 0 ? null : { seq: n - 1, hash: prev };
    const want = opts.expectedHead;
    if (want && (!head || head.seq !== want.seq || head.hash !== want.hash)) {
      // A shorter chain than the anchor is a truncation; a longer or different one is a mismatch at the anchor.
      return { ok: false, code: 'CHAIN_TRUNCATED', index: want.seq };
    }
    return { ok: true, length: n, head };
  } catch {
    return { ok: false, code: 'CHAIN_BAD_RECORD', index: 0 };
  }
}
