// The tenant must only ever be set transaction-locally
// (set_config('ratio.tenant_id', $1, true)). A session-level setting would
// survive COMMIT and leak the tenant into the next use of a pooled connection.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const INGEST_DIR = path.resolve(__dirname);

/** Returns offending snippets: session-level tenant settings. */
function findSessionTenantSettings(source: string): string[] {
  const hits = new Map<number, string>(); // keyed by offset: one hit per occurrence
  const patterns = [
    // set_config('ratio.tenant_id', <anything>, false | 'false' | 0 | 'off')
    /set_config\s*\(\s*'ratio\.tenant_id'\s*,[^;]*?,\s*(?:false|'false'|'f'|'off'|0)\s*\)/gi,
    // set_config with a non-literal is_local we cannot verify
    /set_config\s*\(\s*'ratio\.tenant_id'\s*,[^;]*?,\s*(?!true\s*\))[A-Za-z_$][\w$.]*\s*\)/gi,
    // SET / SET SESSION ratio.tenant_id (SET LOCAL is the only allowed SET form)
    /\bSET\s+(?:SESSION\s+)?(?!LOCAL\b)"?ratio"?\."?tenant_id"?\s*(?:=|TO\b)/gi,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) if (!hits.has(m.index!)) hits.set(m.index!, m[0]);
  return [...hits.values()];
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (/\.(ts|sql)$/.test(entry.name)) acc.push(abs);
  }
  return acc;
}

describe('transaction-local tenant only', () => {
  it('no file under src/ingest sets ratio.tenant_id at session level', () => {
    const files = walk(INGEST_DIR).filter((f) => f !== __filename);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((f) =>
      findSessionTenantSettings(fs.readFileSync(f, 'utf8')).map((hit) => `${path.relative(INGEST_DIR, f)}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it('detector flags session-level forms and accepts transaction-local ones (self-test)', () => {
    const bad = [
      "SELECT set_config('ratio.tenant_id', $1, false)",
      "select set_config('ratio.tenant_id', '00000000-0000-4000-8000-000000000001', 'false')",
      "SELECT set_config('ratio.tenant_id', $1, isLocal)",
      'SET ratio.tenant_id = $1',
      "SET SESSION ratio.tenant_id TO 'x'",
      "set ratio.tenant_id to 'x'",
    ];
    for (const b of bad) expect(findSessionTenantSettings(b), b).toHaveLength(1);
    const good = [
      "SELECT set_config('ratio.tenant_id', $1, true)",
      "SELECT set_config( 'ratio.tenant_id' , $1 , true )",
      "SET LOCAL ratio.tenant_id = 'x'",
      "SELECT current_setting('ratio.tenant_id', true)",
    ];
    for (const g of good) expect(findSessionTenantSettings(g), g).toEqual([]);
  });
});
