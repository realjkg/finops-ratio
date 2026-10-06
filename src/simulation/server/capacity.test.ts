import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MAX_SIMULATION_COMMANDS, MAX_SIMULATION_RESPONSE_BYTES, SimulationDatabase } from './database';
it.each(['count', 'bytes'])('fails closed at the %s quota while preserving immutable state and exact retries', kind => {
  const dir = mkdtempSync(join(tmpdir(), 'ratio-capacity-')); const file = join(dir, 'state.sqlite');
  const db = new SimulationDatabase(file); const raw = new DatabaseSync(file);
  try {
    const actor = { tenant: 'acme', user: 'Capacity', persona: 'technical' as const };
    const command = { type: 'sync', source: 'aws' };
    const saved = db.command(actor, 0, 'original', command);
    if (kind === 'count') {
      const insert = raw.prepare('INSERT INTO commands VALUES (?,?,?,?)');
      raw.exec('BEGIN'); for (let i = 1; i < MAX_SIMULATION_COMMANDS; i++) insert.run(actor.tenant, `quota-${i}`, 'fixture', '{}'); raw.exec('COMMIT');
    } else raw.prepare('INSERT INTO commands VALUES (?,?,?,zeroblob(?))').run(actor.tenant, 'byte-fixture', 'fixture', MAX_SIMULATION_RESPONSE_BYTES);
    const usage = raw.prepare('SELECT count(*) AS n FROM commands WHERE tenant=?').get(actor.tenant);
    expect(() => db.command(actor, saved.revision, 'overflow', { type: 'sync', source: 'azure' })).toThrow(/capacity reached/);
    expect(db.read(actor.tenant)).toEqual(saved);
    expect(raw.prepare('SELECT count(*) AS n FROM commands WHERE tenant=?').get(actor.tenant)).toEqual(usage);
    expect(db.command(actor, 0, 'original', command)).toEqual(saved);
    expect(db.command({ ...actor, tenant: 'northstar' }, 0, 'independent', command).imports).toHaveLength(1);
  } finally { raw.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
