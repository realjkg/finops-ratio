// Tests of the `.next` bundle check (`npm run check:bundle`) on synthetic
// build trees shaped like a Next 16 (Turbopack) production build:
//   .next/static/**                         — everything the browser can download
//   .next/server/pages/**.js                — server entries: R.c("server/chunks/<file>") lines
//   .next/server/chunks/*.js                — server chunks
//   .next/server/pages/**.js.nft.json       — traced runtime files per entry
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { checkNextBundle, CLIENT_FORBIDDEN, COSTS_ENTRY, READER_MARKERS, WORKER_ONLY } from './check-next-bundle.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const entry = (chunks) => [`var R=require("../../chunks/[turbopack]_runtime.js")("x")`, ...chunks.map((c) => `R.c("server/chunks/${c}")`), 'module.exports=R.m(1).exports'].join('\n');
const nft = (files) => JSON.stringify({ version: 1, files });

/** A clean tree: the costs route uses a reader chunk; another route and a page use a shared chunk. */
function cleanTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-bundle-'));
  dirs.push(root);
  write(root, 'static/chunks/app.js', 'console.log("ui")');
  write(root, 'static/chunks/app.js.map', '{"sources":["src/ui.tsx"]}');
  write(root, `server/${COSTS_ENTRY}`, entry(['reader._.js', 'shared._.js']));
  write(root, `server/${COSTS_ENTRY}.nft.json`, nft(['../../../../../../node_modules/pg/lib/index.js', '../../../../../../node_modules/pg-protocol/dist/index.js']));
  write(root, 'server/chunks/reader._.js', `SELECT 1 FROM ratio.cost_facts_published; set_config('ratio.tenant_id'); pg_auth_members`);
  write(root, 'server/chunks/reader._.js.map', '{"sourcesContent":["schema_migrations ingest_artifacts"]}');
  write(root, 'server/chunks/shared._.js', 'export const gateway = 1');
  write(root, 'server/pages/api/v1/connectors.js', entry(['shared._.js']));
  write(root, 'server/pages/api/v1/connectors.js.nft.json', nft(['../../../../../node_modules/next/dist/server/next.js']));
  write(root, 'server/pages/index.js', entry(['shared._.js']));
  return root;
}

const problemsOf = (root) => checkNextBundle(root).problems;

describe('B1 a clean build passes', () => {
  it('reader code only in the costs route’s own chunk, pg traced only for it', () => {
    const root = cleanTree();
    const r = checkNextBundle(root);
    expect(r.problems).toEqual([]);
    expect(r.stats.clientFiles).toBe(2);
    expect(r.stats.serverFiles).toBeGreaterThanOrEqual(4);
  });

  it('the marker lists cover the driver, the tenant setting, the ledger, the view and the worker', () => {
    for (const m of ['pg-protocol', 'ratio.tenant_id', 'schema_migrations', 'cost_facts_published', 'pg_auth_members', 'RATIO_READER_DATABASE_URL']) expect(CLIENT_FORBIDDEN).toContain(m);
    for (const m of ['S3FocusExportSource', 'csv-parse', '@aws-sdk/client-s3']) expect(WORKER_ONLY).toContain(m);
    for (const m of ['cost_facts_published', 'ratio.tenant_id', 'pg_auth_members']) expect(READER_MARKERS).toContain(m);
  });
});

describe('B2 the client bundle never contains ingestion or driver code', () => {
  for (const marker of ['pg-protocol', 'ratio.tenant_id', 'schema_migrations', 'cost_facts_published', 'pg_auth_members', 'S3FocusExportSource', 'csv-parse', 'ingest_artifacts', 'RATIO_READER_DATABASE_URL']) {
    it(`flags ${marker} in .next/static (code or source map)`, () => {
      const root = cleanTree();
      write(root, 'static/chunks/page-x.js', `var a="${marker}"`);
      expect(problemsOf(root).join('\n')).toContain(marker);
      const root2 = cleanTree();
      write(root2, 'static/chunks/page-y.js.map', `{"sourcesContent":["${marker}"]}`);
      expect(problemsOf(root2).join('\n')).toContain(marker);
    });
  }
});

describe('B3 server bundles: reader code only for the costs route, worker code nowhere', () => {
  it('flags a reader marker in a chunk another route also loads', () => {
    const root = cleanTree();
    write(root, 'server/pages/api/v1/connectors.js', entry(['shared._.js', 'reader._.js']));
    expect(problemsOf(root).join('\n')).toMatch(/reader\._\.js.*connectors/);
  });

  it('flags a reader marker in a chunk no entry references, and in another entry file itself', () => {
    const root = cleanTree();
    write(root, 'server/chunks/orphan._.js', 'cost_facts_published');
    expect(problemsOf(root).join('\n')).toContain('orphan._.js');
    const root2 = cleanTree();
    write(root2, 'server/pages/api/hello.js', 'pg_auth_members');
    expect(problemsOf(root2).join('\n')).toContain('hello.js');
  });

  for (const marker of ['S3FocusExportSource', 'FakeFocusSource', 'csv-parse', '@aws-sdk/client-s3', 'MANIFEST_AMBIGUOUS']) {
    it(`flags worker-only ${marker} in any server file, even the costs route's`, () => {
      const root = cleanTree();
      write(root, 'server/chunks/reader._.js', `cost_facts_published ${marker}`);
      expect(problemsOf(root).join('\n')).toContain(marker);
    });
  }

  it('flags pg traced for any route other than the costs route', () => {
    const root = cleanTree();
    write(root, 'server/pages/api/v1/connectors.js.nft.json', nft(['../../../../../node_modules/pg/lib/index.js']));
    expect(problemsOf(root).join('\n')).toMatch(/connectors.*pg/);
  });

  it('flags worker-only packages traced for any route, including the costs route', () => {
    const root = cleanTree();
    write(root, `server/${COSTS_ENTRY}.nft.json`, nft(['../../../../../../node_modules/pg/lib/index.js', '../../../../../../node_modules/@aws-sdk/client-s3/dist-cjs/index.js']));
    expect(problemsOf(root).join('\n')).toContain('@aws-sdk/client-s3');
    const root2 = cleanTree();
    write(root2, 'server/pages/api/v1/connectors.js.nft.json', nft(['../../../../../node_modules/csv-parse/dist/cjs/index.cjs']));
    expect(problemsOf(root2).join('\n')).toContain('csv-parse');
  });

  it('server source maps are not executed or served: their sourcesContent is not judged', () => {
    const root = cleanTree();
    write(root, 'server/chunks/shared._.js.map', '{"sourcesContent":["cost_facts_published"]}');
    expect(problemsOf(root)).toEqual([]);
  });
});

describe('B4 the check is never vacuous', () => {
  it('fails without .next, without client files, or without the costs route', () => {
    const missing = path.join(os.tmpdir(), `ratio-bundle-missing-${process.pid}`);
    expect(problemsOf(missing).join('\n')).toMatch(/no build/i);
    const root = cleanTree();
    fs.rmSync(path.join(root, 'static'), { recursive: true });
    expect(problemsOf(root).join('\n')).toMatch(/static/);
    const root2 = cleanTree();
    fs.rmSync(path.join(root2, 'server', COSTS_ENTRY));
    expect(problemsOf(root2).join('\n')).toMatch(/costs route/);
  });

  it('fails when the costs route’s chunks show no reader code (the scan would be blind)', () => {
    const root = cleanTree();
    write(root, 'server/chunks/reader._.js', 'nothing here');
    expect(problemsOf(root).join('\n')).toMatch(/blind|no reader/i);
  });

  it('fails when pg is not traced for the costs route', () => {
    const root = cleanTree();
    write(root, `server/${COSTS_ENTRY}.nft.json`, nft([]));
    expect(problemsOf(root).join('\n')).toMatch(/pg/);
  });
});
