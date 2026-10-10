import { expect, it } from 'vitest';
import { SimulationDatabase } from './database';
import { IDENTITIES } from './http';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

it('does not replay a privileged response after the same user changes role', () => {
  const db = new SimulationDatabase(':memory:');
  const actor = IDENTITIES['acme-executive'];
  try {
    const initial = db.read(actor.tenant);
    const command = { type: 'budget', workloadId: initial.workloads[0].id, amount: 5000 };
    const saved = db.command(actor, 0, 'privileged-request', command);
    expect(() => db.command({ ...actor, persona: 'technical' }, 0, 'privileged-request', command)).toThrow(/identity/);
    expect(() => db.command({ ...actor, user: 'Other executive' }, 0, 'privileged-request', command)).toThrow(/identity/);
    expect(db.read(actor.tenant)).toEqual(saved);
    expect(db.command(actor, 0, 'privileged-request', command)).toEqual(saved);
  } finally { db.close(); }
});

it('rejects legacy role-less retries without reapplying the financial command', () => {
  const db = new SimulationDatabase(':memory:');
  const actor = IDENTITIES['acme-executive'];
  try {
    const initial = db.read(actor.tenant);
    const command = { type: 'budget', workloadId: initial.workloads[0].id, amount: 5000 };
    const saved = db.command(actor, 0, 'legacy-request', command);
    const sql = (db as unknown as { db: DatabaseSync }).db;
    const legacy = createHash('sha256').update(JSON.stringify({ user: actor.user, command })).digest('hex');
    sql.prepare('UPDATE commands SET fingerprint=? WHERE tenant=? AND id=?').run(legacy, actor.tenant, 'legacy-request');
    expect(() => db.command(actor, 0, 'legacy-request', command)).toThrow(/Reload and review/);
    expect(db.read(actor.tenant)).toEqual(saved);
  } finally { db.close(); }
});

it('rolls back unreadable replay data before committing and remains usable', () => {
  const db = new SimulationDatabase(':memory:');
  const actor = IDENTITIES['acme-technical'];
  try {
    const command = { type: 'sync', source: 'aws' };
    const saved = db.command(actor, 0, 'corrupt-response', command);
    const sql = (db as unknown as { db: DatabaseSync }).db;
    sql.prepare('UPDATE commands SET response=? WHERE tenant=? AND id=?').run('{invalid', actor.tenant, 'corrupt-response');
    expect(() => db.command(actor, 0, 'corrupt-response', command)).toThrow(SyntaxError);
    expect(db.read(actor.tenant)).toEqual(saved);
    expect(db.command(actor, saved.revision, 'next-request', { type: 'sync', source: 'gcp' }).revision).toBe(saved.revision + 1);
  } finally { db.close(); }
});

it.each(Object.entries(IDENTITIES))('%s enforces role boundaries without changing financial or audit history on rejection', (_id, actor) => {
  const db = new SimulationDatabase(':memory:');
  try {
    const before = db.read(actor.tenant);
    const otherTenant = actor.tenant === 'acme' ? 'northstar' : 'acme';
    const other = db.read(otherTenant);
    const denied = actor.persona === 'technical'
      ? { type: 'budget', workloadId: before.workloads[0].id, amount: 1 }
      : { type: 'sync', source: 'aws' };
    expect(() => db.command(actor, 0, 'denied', denied)).toThrow(/permission/);
    expect(db.read(actor.tenant)).toEqual(before);
    const saved = db.command(actor, 0, 'frank', { type: 'queue-agent-review', workloadId: before.workloads[0].id });
    expect(saved.ledger).toEqual(before.ledger);
    expect(saved.outcomes).toEqual(before.outcomes);
    expect(saved.workloads).toEqual(before.workloads);
    expect(saved.audit.length).toBe(before.audit.length + 1);
    expect(db.read(otherTenant)).toEqual(other);
  } finally { db.close(); }
});

it('requires a different human approver before a technical user applies a change', () => {
  const db = new SimulationDatabase(':memory:');
  const tech = IDENTITIES['acme-technical'];
  const reviewer = IDENTITIES['acme-executive'];
  try {
    const before = db.read('acme'); const workloadId = before.workloads[0].id;
    let saved = db.command(tech, 0, 'request', { type: 'request-change', workloadId });
    expect(() => db.command(tech, saved.revision, 'premature', { type: 'apply-change', workloadId })).toThrow(/approved/);
    expect(() => db.command({ ...reviewer, user: tech.user }, saved.revision, 'self-approval', { type: 'approve-change', workloadId })).toThrow(/own change/);
    expect(db.read('acme')).toEqual(saved);
    saved = db.command(reviewer, saved.revision, 'approval', { type: 'approve-change', workloadId });
    saved = db.command(tech, saved.revision, 'apply', { type: 'apply-change', workloadId });
    expect(saved.changes[workloadId].status).toBe('applied');
    expect(saved.ledger).toEqual(before.ledger);
    expect(saved.audit.map(a => a.action)).toEqual(['request-change', 'approve-change', 'apply-change']);
  } finally { db.close(); }
});
