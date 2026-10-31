#!/usr/bin/env node
// `npm run check:bundle` — the `.next` bundle check (Slice 0/1 ran it as a
// manual grep; Slice 2 makes it a script and a CI step, because a Next route
// now legitimately imports the Postgres driver on the SERVER).
//
// Rules, on a Next 16 (Turbopack) production build:
//   1. CLIENT (.next/static/**, every file the browser can download, source
//      maps included): no driver, ingestion, ledger, reader or worker marker.
//   2. SERVER entries (.next/server/pages/**.js) load chunks with lines
//      `R.c("server/chunks/<file>")`. A server .js file holding READER code
//      must be a reader route itself (READER_ENTRIES: the costs, report-facts and
//      engagement-report routes) or a chunk ONLY reader routes load.
//   3. Worker-only code (S3 source, fake source, CSV parser, S3 SDK, worker
//      error codes) appears in no server .js file, the costs route included.
//   4. Traced runtime files (<entry>.js.nft.json): `pg` only for the reader
//      routes; worker-only packages for no route.
//   5. Never vacuous: .next, client files and the costs route must exist; the
//      costs route's chunks must show reader code and pg must be traced for
//      every reader route present.
// Server source maps (.map) are neither executed nor served; their
// sourcesContent is not judged. Exit 0 = clean, 1 = problems, printed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Relative to .next/server. */
export const COSTS_ENTRY = 'pages/api/v1/costs/published.js';
export const REPORT_FACTS_ENTRY = 'pages/api/v1/reports/facts.js';
/** The only server entries that may load reader code and pg (the reviewed read-API island). */
export const ENGAGEMENT_REPORT_ENTRY = 'pages/api/v1/reports/engagement.js';
export const READER_ENTRIES = [COSTS_ENTRY, REPORT_FACTS_ENTRY, ENGAGEMENT_REPORT_ENTRY];

export const WORKER_ONLY = [
  'S3FocusExportSource',
  'FakeFocusSource',
  'S3EvidenceStore',
  'csv-parse',
  '@aws-sdk/client-s3',
  'MANIFEST_AMBIGUOUS',
  'EVIDENCE_CONFLICT',
  'replay-fixtures',
  // M0a managed connector runtime (src/connectors/managed, worker-only).
  'CONNECTOR_NOT_REGISTERED',
  'RATIO_SECRETS_DIR',
  'connector-originals',
  'DELIVERY_INCOMPLETE',
];
// Database code of the read API (an env-var NAME is not code: the startup hook's pure config names it).
export const READER_MARKERS = ['cost_facts_published', 'ratio.tenant_id', 'pg_auth_members'];
export const CLIENT_FORBIDDEN = [
  'pg-protocol',
  'pg-connection-string',
  'schema_migrations',
  'ingest_artifacts',
  'ingest_validation_errors',
  'REFUSED_PREDEFINED',
  'pg_read_server_files',
  'withTenantTransaction',
  'RATIO_READER_DATABASE_URL',
  ...READER_MARKERS,
  ...WORKER_ONLY,
];

const PG_TRACE = /(^|\/)node_modules\/pg(-[a-z-]+)?\//;
const WORKER_TRACE = /(^|\/)node_modules\/(@aws-sdk\/|csv-parse\/)/;
const CHUNK_REF = /R\.c\("server\/(chunks\/[^"]+)"\)/g;

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

const has = (text, markers) => markers.filter((m) => text.includes(m));

export function checkNextBundle(nextDir) {
  const problems = [];
  const stats = { clientFiles: 0, serverFiles: 0 };
  if (!fs.existsSync(nextDir)) return { problems: [`no build at ${nextDir}: run npm run build first`], stats };
  const rel = (f) => path.relative(nextDir, f).split(path.sep).join('/');

  // 1. client
  const client = walk(path.join(nextDir, 'static'));
  stats.clientFiles = client.length;
  if (client.length === 0) problems.push('no client files under .next/static (the scan would be blind)');
  for (const f of client) {
    for (const m of has(fs.readFileSync(f, 'utf8'), CLIENT_FORBIDDEN)) problems.push(`client file ${rel(f)} contains ${m}`);
  }

  // 2./3. server
  const serverDir = path.join(nextDir, 'server');
  const serverJs = walk(serverDir).filter((f) => /\.(c|m)?js$/.test(f));
  stats.serverFiles = serverJs.length;
  const costsEntry = path.join(serverDir, COSTS_ENTRY);
  if (!fs.existsSync(costsEntry)) problems.push(`the costs route ${COSTS_ENTRY} is missing from the build`);
  const entries = walk(path.join(serverDir, 'pages')).filter((f) => f.endsWith('.js'));
  const loadedBy = new Map(); // chunk abs path -> entries (rel)
  for (const e of entries) {
    for (const m of fs.readFileSync(e, 'utf8').matchAll(CHUNK_REF)) {
      const chunk = path.join(serverDir, m[1]);
      if (!loadedBy.has(chunk)) loadedBy.set(chunk, new Set());
      loadedBy.get(chunk).add(rel(e));
    }
  }
  const readerRel = new Set(READER_ENTRIES.map((e) => rel(path.join(serverDir, e))));
  let readerSeen = false;
  for (const f of serverJs) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of has(text, WORKER_ONLY)) problems.push(`server file ${rel(f)} contains worker-only ${m}`);
    const reader = has(text, READER_MARKERS);
    if (reader.length === 0) continue;
    if (readerRel.has(rel(f))) {
      readerSeen = true;
      continue;
    }
    const users = [...(loadedBy.get(f) ?? [])];
    if (users.length > 0 && users.every((u) => readerRel.has(u))) {
      readerSeen = true;
      continue;
    }
    problems.push(
      `server file ${rel(f)} contains reader code (${reader.join(', ')}) but is loaded by ${users.length ? users.join(', ') : 'no entry'}; only ${[...readerRel].join(' or ')} may load it`,
    );
  }
  if (fs.existsSync(costsEntry) && !readerSeen) problems.push('no reader code found in the costs route or its own chunks (the scan would be blind)');

  // 4. traces
  const pgTraced = new Set();
  for (const t of walk(serverDir).filter((f) => f.endsWith('.nft.json'))) {
    let files;
    try {
      files = JSON.parse(fs.readFileSync(t, 'utf8')).files ?? [];
    } catch {
      problems.push(`unreadable trace ${rel(t)}`);
      continue;
    }
    const entryRel = rel(t).replace(/\.nft\.json$/, '');
    const isReader = readerRel.has(entryRel);
    for (const f of files) {
      if (WORKER_TRACE.test(f)) problems.push(`trace ${rel(t)} includes worker-only package ${f.replace(/^.*node_modules\//, '')}`);
      if (PG_TRACE.test(f)) {
        if (isReader) pgTraced.add(entryRel);
        else problems.push(`trace ${rel(t)} includes pg (${f.replace(/^.*node_modules\//, '')}); only the reader routes may load the driver`);
      }
    }
  }
  for (const e of READER_ENTRIES) {
    if (fs.existsSync(path.join(serverDir, e)) && !pgTraced.has(rel(path.join(serverDir, e)))) {
      problems.push(`pg is not traced for ${e === COSTS_ENTRY ? 'the costs route' : e} (unexpected build layout: the scan would be blind)`);
    }
  }

  return { problems, stats };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, stats } = checkNextBundle(path.join(root, '.next'));
  process.stdout.write(`${JSON.stringify({ type: 'ratio.bundle-check', pass: problems.length === 0, stats, problems })}\n`);
  process.exit(problems.length ? 1 : 0);
}
