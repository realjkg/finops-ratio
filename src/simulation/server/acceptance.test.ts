import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SimulationDatabase } from './database';
import { IDENTITIES } from './http';
import { COST_CATEGORIES } from '@/outcomes/types';
import { evaluateOutcome } from '@/outcomes/model';
import { outcomeReportRows } from '@/outcomes/report';
import type { Command, SimIdentity } from '../types';

it.each(['acme', 'northstar'])('%s persists the complete three-persona customer journey and restores its evidence', tenant => {
  const dir = mkdtempSync(join(tmpdir(), 'ratio-acceptance-'));
  const file = join(dir, 'customer.sqlite');
  let db = new SimulationDatabase(file);
  try {
    const technical = IDENTITIES[`${tenant}-technical`];
    const procurement = IDENTITIES[`${tenant}-procurement`];
    const executive = IDENTITIES[`${tenant}-executive`];
    const sessions = [technical, procurement, executive].map(actor => db.createSession(actor));
    for (const session of sessions) expect(db.session(session.token)?.identity).toEqual(session.identity);
    const otherTenant = tenant === 'acme' ? 'northstar' : 'acme';
    const other = db.read(otherTenant);
    const initial = db.read(tenant);
    const workloadId = initial.workloads[0].id;
    const send = (actor: SimIdentity, command: Command, id = randomUUID()) =>
      db.command(actor, db.read(tenant).revision, id, { workloadId, ...command });
    const requestId = randomUUID();
    const sync = { type: 'sync', source: 'aws' };
    const imported = send(technical, sync, requestId);
    expect(imported.ledger.slice(0, initial.ledger.length)).toEqual(initial.ledger);
    expect(db.command(technical, 0, requestId, { workloadId, ...sync })).toEqual(imported);
    expect(send(technical, sync).ledger).toEqual(imported.ledger);
    for (const source of ['azure', 'gcp']) {
      const synced = send(technical, { type: 'sync', source });
      expect(send(technical, { type: 'sync', source })).toEqual(synced);
    }
    const reconciled = db.read(tenant);
    expect(reconciled.imports).toHaveLength(3);
    expect(reconciled.ledger.slice(0, initial.ledger.length)).toEqual(initial.ledger);
    const plan = { ...reconciled.outcomes[workloadId], owner: executive.user, target: 80 };
    send(technical, { type: 'save-outcome-plan', plan });
    expect(() => send(technical, { type: 'verify-outcome-plan' })).toThrow(/permission/);
    for (const category of COST_CATEGORIES) send(technical, {
      type: 'save-full-cost', category,
      cost: { cents: 10000, status: 'measured', reference: `Simulated ${category} invoice` },
    });
    const costs = evaluateOutcome(db.read(tenant).outcomes[workloadId], db.read(tenant).ledger);
    send(technical, { type: 'save-value-measure', measure: {
      id: 'acceptance-savings', category: 'cost_savings', title: 'Realized simulated savings',
      status: 'measured', amountCents: costs.estimatedCostCents * 4,
      contributionMarginPct: 100, attributionPct: 100,
      reference: 'Simulated comparison invoice', method: 'Equal-period control comparison',
    } });
    const decision = { type: 'record-outcome-decision', action: 'continue', rationale: 'Reviewed return and performance meet the continuation threshold.' };
    expect(() => send(executive, decision)).toThrow(/review/);
    send(procurement, { type: 'verify-outcome-plan' });
    send(procurement, { type: 'verify-value-measure', measureId: 'acceptance-savings' });
    for (const category of COST_CATEGORIES) send(procurement, { type: 'verify-full-cost', category });
    expect(evaluateOutcome(db.read(tenant).outcomes[workloadId], db.read(tenant).ledger).measuredRatio).toBe(4);
    send(executive, decision);
    const beforeFrank = db.read(tenant);
    const proposal = send(technical, { type: 'review-with-frank' });
    expect(proposal.ledger).toEqual(beforeFrank.ledger);
    expect(proposal.outcomes).toEqual(beforeFrank.outcomes);
    expect(proposal.agentJobs.at(-1)?.status).toBe('review');
    send(executive, { type: 'review-agent-proposal', jobId: proposal.agentJobs.at(-1)!.id, resolution: 'accepted', rationale: 'Reviewed the bounded recommendation against saved evidence.' });
    send(technical, { type: 'request-change' });
    expect(() => send(technical, { type: 'apply-change' })).toThrow(/approved/);
    send(procurement, { type: 'approve-change' });
    send(technical, { type: 'apply-change' });
    const saved = db.read(tenant);
    expect(saved.changes[workloadId].status).toBe('applied');
    expect(saved.ledger).toEqual(reconciled.ledger);
    expect(outcomeReportRows(saved.workloads, saved.outcomes, saved.ledger)[0].decisionStale).toBe(false);
    expect(db.read(otherTenant)).toEqual(other);
    db.close();
    db = new SimulationDatabase(file);
    expect(db.read(tenant)).toEqual(saved);
    for (const session of sessions) expect(db.session(session.token)).not.toBeNull();
    const snapshot = join(dir, 'backup.sqlite');
    const restored = join(dir, 'restored.sqlite');
    execFileSync(process.execPath, ['scripts/simulation/storage.mjs', 'backup', file, snapshot]);
    execFileSync(process.execPath, ['scripts/simulation/storage.mjs', 'restore', snapshot, restored]);
    const recovery = new SimulationDatabase(restored);
    try {
      expect(recovery.integrity()).toBe(true);
      expect(recovery.read(tenant)).toEqual(saved);
      expect(recovery.read(otherTenant)).toEqual(other);
      for (const session of sessions) expect(recovery.session(session.token)).toBeNull();
      expect(recovery.command(technical, 0, requestId, { workloadId, ...sync })).toEqual(imported);
    } finally { recovery.close(); }
    send(technical, { type: 'save-full-cost', category: 'labor', cost: { cents: 20000, status: 'measured', reference: 'Updated simulated timesheet' } });
    expect(outcomeReportRows(db.read(tenant).workloads, db.read(tenant).outcomes, db.read(tenant).ledger)[0].decisionStale).toBe(true);
    expect(() => send(executive, decision)).toThrow(/review/);
    for (const session of sessions) { db.revoke(session.token); expect(db.session(session.token)).toBeNull(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
