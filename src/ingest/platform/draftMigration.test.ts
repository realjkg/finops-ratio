// A1 draft migration 0020_platform_connections (ADR-0001 §12). The ledger reserves 0020 for A1 but forbids any 0020+
// migration while 0005-0019 are reserved, so the SQL ships as a DRAFT outside src/ingest/db/migrations. These checks
// run the runner's own static rules on it, so promotion later is a move, not a rewrite; RLS is exercised against
// Postgres in connections.db.test.ts.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, findForbiddenStatement, findNonExpandStatement, findTransactionControl, stripNonCode } from '../db/migrationFiles';
import { CONNECTION_LADDER, CONNECTOR_CATEGORIES, LADDER_FROM_MANAGED_STATE, VERIFICATION } from '../../platform/contracts/connector';
import { EVIDENCE_KINDS, EVIDENCE_REF_SCHEMA } from './connections';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DRAFTS = path.join(ROOT, 'docs', 'migrations', 'drafts');
const UP = fs.readFileSync(path.join(DRAFTS, '0020_platform_connections.up.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(DRAFTS, '0020_platform_connections.down.sql'), 'utf8');
const CODE = stripNonCode(UP);
const TABLES = ['platform_connections', 'platform_evidence_refs'];
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
/** The body of `CREATE TABLE ratio.<t> ( ... );` in code (comments and literals blanked). */
const body = (t: string) => {
  const start = CODE.indexOf(`CREATE TABLE ratio.${t} (`);
  expect(start, t).toBeGreaterThanOrEqual(0);
  return UP.slice(start, CODE.indexOf('\n);', start));
};

describe('draft 0020_platform_connections (not a migration yet)', () => {
  it('lives outside the migrations directory, so the ledger guard stays green while 0005-0019 are reserved', () => {
    expect(fs.readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.startsWith('0020'))).toEqual([]);
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'migrations', 'ledger.json'), 'utf8')).entries;
    expect(ledger.find((e: { number?: string }) => e.number === '0020')).toMatchObject({ status: 'reserved', owner: expect.stringMatching(/^A1 /) });
    expect(UP.split('\n')[0]).toBe('-- ratio:phase expand');
    expect(UP).toMatch(/^-- DRAFT /m);
  });
  it('passes the runner\'s static rules: expand-only, no forbidden statement, no transaction control', () => {
    expect(findNonExpandStatement(UP)).toBeNull();
    expect(findForbiddenStatement(UP)).toBeNull();
    expect(findTransactionControl(UP)).toBeNull();
    expect(findTransactionControl(DOWN)).toBeNull();
    expect(CODE).toMatch(/^SET LOCAL ROLE ratio_owner;$/m);
  });
  it('every table is tenant-scoped: tenant_id, a composite primary key, schema_version, RLS enabled and forced with the reviewed policy', () => {
    expect([...CODE.matchAll(/CREATE TABLE ratio\.(\w+)/g)].map((m) => m[1])).toEqual(TABLES);
    for (const t of TABLES) {
      const b = body(t);
      expect(b, t).toMatch(/^\s+tenant_id\s+uuid NOT NULL\b/m);
      expect(b, t).toMatch(/^\s+schema_version\s+text NOT NULL CHECK \(schema_version = '[a-z-]+\/\d+'\)/m);
      expect(b, t).toMatch(/PRIMARY KEY \(tenant_id, /);
      expect(CODE).toContain(`ALTER TABLE ratio.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(CODE).toContain(`ALTER TABLE ratio.${t} FORCE ROW LEVEL SECURITY;`);
      expect(CODE).toContain(`CREATE POLICY tenant_isolation ON ratio.${t}\n  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());`);
    }
    expect(body('platform_connections')).toContain("CHECK (schema_version = 'connector-declaration/1')");
    expect(body('platform_evidence_refs')).toContain(`CHECK (schema_version = '${EVIDENCE_REF_SCHEMA}')`);
    // Every foreign key carries tenant_id.
    for (const fk of CODE.matchAll(/FOREIGN KEY \(([^)]*)\) REFERENCES ratio\.\w+ \(([^)]*)\)/g)) {
      expect(fk[1].split(',')[0].trim()).toBe('tenant_id');
      expect(fk[2].split(',')[0].trim()).toBe('tenant_id');
    }
  });
  it('the stored ladder is the M0a map, exactly: every M0a state, five steps, off-ladder states have none, never "connected"', () => {
    const c = body('platform_connections');
    expect(c).toContain(`managed_state   text NOT NULL CHECK (managed_state IN (${list(Object.keys(LADDER_FROM_MANAGED_STATE))}))`);
    for (const [state, step] of Object.entries(LADDER_FROM_MANAGED_STATE)) {
      if (step) expect(c, state).toContain(`WHEN '${state}' THEN '${step}'`);
      else expect(c, state).not.toContain(`WHEN '${state}'`);
    }
    expect(new Set([...c.matchAll(/THEN '(\w+)'/g)].map((m) => m[1]))).toEqual(new Set(CONNECTION_LADDER));
    expect(c).toContain(`category        text NOT NULL CHECK (category IN (${list(CONNECTOR_CATEGORIES)}))`);
    expect(c).toContain(`verification    text NOT NULL CHECK (verification IN (${list(VERIFICATION)}))`);
    expect(body('platform_evidence_refs')).toContain(`kind           text NOT NULL CHECK (kind IN (${list(Object.keys(EVIDENCE_KINDS))}))`);
    expect(UP.replace(/^--.*$/gm, '')).not.toMatch(/connected/i);
  });
  it('evidence refs are append-only for the worker; nothing is granted to the reader or PUBLIC', () => {
    const grants = [...CODE.matchAll(/^GRANT (.+) ON (.+) TO (\w+);$/gm)].map((m) => [m[1], m[2], m[3]]);
    expect(grants).toEqual([
      ['SELECT, INSERT, UPDATE', 'ratio.platform_connections', 'ratio_worker'],
      ['SELECT, INSERT', 'ratio.platform_evidence_refs', 'ratio_worker'],
    ]);
    expect(CODE).not.toMatch(/\bPUBLIC\b|ratio_reader/);
  });
  it('the down file drops exactly the two tables, children first', () => {
    expect(stripNonCode(DOWN).split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['DROP TABLE IF EXISTS ratio.platform_evidence_refs;', 'DROP TABLE IF EXISTS ratio.platform_connections;']);
  });
});
