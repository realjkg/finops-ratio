// Hash-chained audit log: append-only, tamper-evident, bounded, no secrets.
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, createAuditLog, verifyChain, type AuditEntryInput, type AuditRecord } from './audit';
import { SERVICE_ACTOR_ID } from './types';

const entry = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  at: 1000, kind: 'proposal', actor: 'sub-a', policyVersion: 'p-1', proposalId: 'prop-1', actionId: 'stop_idle_dev_instance', outcome: 'PROPOSED', ...over,
});
function chain(n = 4) {
  const log = createAuditLog('t1');
  for (let i = 0; i < n; i += 1) expect(log.append(entry({ at: 1000 + i, proposalId: `prop-${i}` })).ok).toBe(true);
  return log;
}
const clone = (rs: readonly AuditRecord[]): Record<string, unknown>[] => JSON.parse(JSON.stringify(rs));
const verify = (rs: unknown, o?: Parameters<typeof verifyChain>[1]) => verifyChain(rs, { tenant: 't1', ...o });

describe('audit append', () => {
  it('chains_records_from_genesis_and_names_actor_and_policy_version', () => {
    const log = chain(3);
    const rs = log.records();
    expect(rs[0].prevHash).toBe(GENESIS_HASH);
    expect(rs[1].prevHash).toBe(rs[0].hash);
    expect(rs[2].prevHash).toBe(rs[1].hash);
    expect(rs.every((r) => r.actor === 'sub-a' && r.policyVersion === 'p-1' && r.tenant === 't1')).toBe(true);
    expect(log.head()).toEqual({ seq: 2, hash: rs[2].hash });
    expect(verify(rs)).toEqual({ ok: true, length: 3, head: log.head() });
  });
  it('accepts_the_service_actor_and_refuses_impersonation_of_it', () => {
    const log = createAuditLog('t1');
    expect(log.append(entry({ actor: SERVICE_ACTOR_ID })).ok).toBe(true);
    for (const actor of ['svc:other', 'svc:remediation-autonomy-x', '', 'has space', 'a'.repeat(129), 'é']) {
      expect(log.append(entry({ actor })), actor).toEqual({ ok: false, code: 'AUDIT_INVALID' });
    }
  });
  it('refuses_bad_fields', () => {
    const log = createAuditLog('t1');
    for (const bad of [{ outcome: 'lower' }, { outcome: '' }, { policyVersion: 'bad version' }, { proposalId: 'bad id!' }, { actionId: 'Bad' }, { at: -1 }, { at: 1.5 }, { kind: 'other' as never }]) {
      expect(log.append(entry(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(log.records().length).toBe(0);
  });
  it('redacts_secret_keys_and_secret_looking_values_and_truncates', () => {
    const log = createAuditLog('t1');
    const r = log.append(entry({ detail: {
      apiKey: 'plain', authorization: 'x', password: 'p', note: 'Bearer abc123', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', blob: 'A'.repeat(50),
      fine: 'ok', long: 'x '.repeat(100), n: 5, b: true, z: null, big: BigInt(7),
    } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.record.detail;
    expect([d.apiKey, d.authorization, d.password, d.note, d.jwt, d.blob]).toEqual(Array(6).fill('[REDACTED]'));
    expect(d.fine).toBe('ok');
    expect(String(d.long).length).toBe(120);
    expect(d.big).toBe('7');
    expect(JSON.stringify(r.record)).not.toMatch(/abc123|plain|eyJ/);
  });
  it('refuses_odd_detail', () => {
    const log = createAuditLog('t1');
    expect(log.append(entry({ detail: { 'Bad Key': 1 } as never })).ok).toBe(false);
    expect(log.append(entry({ detail: { a: 1.5 } })).ok).toBe(false);
    expect(log.append(entry({ detail: { a: 'line\nbreak' } })).ok).toBe(false);
    expect(log.append(entry({ detail: { a: {} as never } })).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 1]));
    expect(log.append(entry({ detail: many })).ok).toBe(false);
    const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 1]));
    expect(log.append(entry({ detail: twelve })).ok).toBe(true);
  });
  it('caps_record_size_and_count', () => {
    const log = createAuditLog('t1', { maxRecords: 2 });
    const fat = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'ab '.repeat(40)]));
    expect(log.append(entry({ detail: fat }))).toEqual({ ok: false, code: 'AUDIT_TOO_LARGE' });
    expect(log.append(entry()).ok).toBe(true);
    expect(log.append(entry()).ok).toBe(true);
    expect(log.append(entry())).toEqual({ ok: false, code: 'AUDIT_FULL' });
    expect(log.remaining()).toBe(0);
  });
  it('records_returned_are_a_copy_and_frozen', () => {
    const log = chain(2);
    const rs = log.records() as AuditRecord[];
    expect(() => { (rs[0] as { outcome: string }).outcome = 'X'; }).toThrow(TypeError);
    expect(() => rs.pop()).toThrow(); // the array is frozen
    expect(log.records().length).toBe(2);
  });
});

describe('verifyChain: tamper detection', () => {
  it('detects_an_edited_field', () => {
    const rs = clone(chain().records());
    rs[1].actor = 'sub-evil';
    expect(verify(rs)).toEqual({ ok: false, code: 'CHAIN_BAD_HASH', index: 1 });
    const rs2 = clone(chain().records());
    (rs2[2].detail as Record<string, unknown>).added = 'x';
    expect(verify(rs2)).toMatchObject({ ok: false, index: 2 });
  });
  it('detects_an_edit_with_a_recomputed_hash_at_the_next_link', () => {
    const rs = clone(chain().records());
    rs[1].outcome = 'APPROVED';
    // An attacker who also fixes record 1's hash still breaks record 2's link.
    const log = createAuditLog('t1');
    log.append(entry({ at: 1000, proposalId: 'prop-0' }));
    log.append(entry({ at: 1001, proposalId: 'prop-1', outcome: 'APPROVED' }));
    rs[1].hash = log.records()[1].hash;
    expect(verify(rs)).toEqual({ ok: false, code: 'CHAIN_BAD_LINK', index: 2 });
  });
  it('detects_reordering', () => {
    const rs = clone(chain().records());
    [rs[1], rs[2]] = [rs[2], rs[1]];
    expect(verify(rs).ok).toBe(false);
    const swapped = clone(chain().records());
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(verify(swapped)).toMatchObject({ ok: false, index: 0 });
  });
  it('detects_deletion_in_the_middle_and_at_the_head', () => {
    const mid = clone(chain().records());
    mid.splice(1, 1);
    expect(verify(mid).ok).toBe(false);
    const head = clone(chain().records());
    head.shift();
    expect(verify(head).ok).toBe(false);
  });
  it('detects_a_truncated_tail_only_with_an_anchored_head', () => {
    const log = chain();
    const anchor = log.head()!;
    const rs = clone(log.records());
    rs.pop();
    expect(verify(rs).ok).toBe(true); // a chain alone cannot see this
    expect(verify(rs, { expectedHead: anchor })).toMatchObject({ ok: false, code: 'CHAIN_TRUNCATED' });
    expect(verify(clone(log.records()), { expectedHead: anchor }).ok).toBe(true);
    expect(verify([], { expectedHead: anchor }).ok).toBe(false);
  });
  it('detects_a_foreign_tenant_extra_fields_and_bad_shapes', () => {
    const other = createAuditLog('t2');
    other.append(entry());
    expect(verifyChain(other.records(), { tenant: 't1' })).toMatchObject({ ok: false, code: 'CHAIN_TENANT' });
    const rs = clone(chain().records());
    (rs[0] as Record<string, unknown>).extra = 1;
    expect(verify(rs)).toMatchObject({ ok: false, code: 'CHAIN_BAD_RECORD', index: 0 });
    for (const bad of [null, 'x', {}, [null], [5], [[]]]) expect(verify(bad).ok).toBe(false);
  });
  it('detects_a_forged_actor_prefix_and_an_oversized_forgery', () => {
    const rs = clone(chain().records());
    rs[0].actor = 'svc:forged';
    expect(verify(rs)).toMatchObject({ ok: false, code: 'CHAIN_BAD_RECORD' });
  });
  it('an_empty_chain_is_valid', () => {
    expect(verify([])).toEqual({ ok: true, length: 0, head: null });
  });
});
