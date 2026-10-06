import { describe, expect, it } from 'vitest';
import { assertLedgerAppendOnly, seedWorkspace, executeCommand } from './workflow';
import type { SimIdentity } from '../types';
const tech: SimIdentity = { tenant: 'acme', user: 'engineer', persona: 'technical' };
const buyer: SimIdentity = { tenant: 'acme', user: 'buyer', persona: 'procurement' };
describe('persisted customer workflow', () => {
  it('reconciles seed ledger exactly and applies each import only once', () => {
    const s = seedWorkspace();
    expect(s.ledger.reduce((n, r) => n + r.cents, 0)).toBe(s.workloads.reduce((n, w) => n + Math.round(w.costs.monthly_spend * 100), 0));
    const a = executeCommand(s, tech, { type: 'sync', source: 'aws' });
    const b = executeCommand(a, tech, { type: 'sync', source: 'aws' });
    expect(b.ledger).toEqual(a.ledger);
    expect(b.workloads).toEqual(a.workloads);
  });
  it('enforces append-only ledger history and reserves appends for connector sync', () => {
    const before = seedWorkspace();
    const synced = executeCommand(before, tech, { type: 'sync', source: 'aws' });
    expect(() => assertLedgerAppendOnly(before, synced, true)).not.toThrow();
    const rewritten = structuredClone(synced);
    rewritten.ledger[0].cents += 1;
    expect(() => assertLedgerAppendOnly(synced, rewritten, false)).toThrow(/append-only/);
    const unauthorizedAppend = structuredClone(before);
    unauthorizedAppend.ledger.push({ ...before.ledger[0], id: 'unauthorized-append' });
    expect(() => assertLedgerAppendOnly(before, unauthorizedAppend, false)).toThrow(/append-only/);
  });
  it('requires approval from another persona before applying a simulated change', () => {
    const s = seedWorkspace();
    const id = s.workloads[0].id;
    const requested = executeCommand(s, tech, { type: 'request-change', workloadId: id });
    expect(() => executeCommand(requested, tech, { type: 'approve-change', workloadId: id })).toThrow(/permission/i);
    expect(() => executeCommand(requested, tech, { type: 'apply-change', workloadId: id })).toThrow(/approved/i);
    const approved = executeCommand(requested, buyer, { type: 'approve-change', workloadId: id });
    const applied = executeCommand(approved, tech, { type: 'apply-change', workloadId: id });
    expect(applied.changes[id].status).toBe('applied');
    expect(applied.ledger).toEqual(s.ledger); // A projection is never a realized saving.
  });
  it('rejects invalid budgets, thresholds and unknown actions', () => {
    const s = seedWorkspace(); const workloadId = s.workloads[0].id;
    expect(() => executeCommand(s, buyer, { type: 'budget', workloadId, amount: -1 })).toThrow();
    expect(() => executeCommand(s, tech, { type: 'thresholds', workloadId, soft: .95, hard: .9, kill: 1 })).toThrow();
    expect(() => executeCommand(s, tech, { type: 'anything' })).toThrow();
  });
});
