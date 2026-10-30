// M0a boundary (owner directive E3, defect D1/D4): managed connectors run only
// in the worker. ALL of src/connectors/managed/** is worker-only, except the
// explicit carve-out below. No file Next can bundle (proxy.ts, middleware.ts,
// instrumentation.ts, app/**, pages/**, src/** outside the worker) may reach a
// worker-only managed module, statically or transitively, through static,
// dynamic (also template-literal) or require imports, the `@/` alias or a bare
// `src/...` baseUrl import; and managed code never uses the demo parser (float
// money, invented zeros).
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MANAGED_CONNECTORS } from '../../engagement/config';
import { managedRegistry } from './registry';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANAGED = path.join(ROOT, 'src', 'connectors', 'managed');
// Carve-out: the PointFive MCP client, merged before M0a, which the web-side cost source
// (src/costsource/PointFiveMcpTransport.ts, PointFiveLiveAdapter.ts, pointfiveConfig.ts) imports.
// Named file by file; anything else under src/connectors/managed is worker-only.
const WEB_ALLOWED = ['pointfive/errors.ts', 'pointfive/mcpClient.ts', 'pointfive/discovery.ts', 'pointfive/health.ts', 'pointfive/sse.ts'].map((p) => path.join(MANAGED, p));
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(abs, acc);
    } else if (EXT.test(e.name)) acc.push(abs);
  }
  return acc;
}

/** Virtual files for the detector self-test (nothing is written to disk). */
const VFS = new Map<string, string>();
const exists = (c: string) => VFS.has(c) || (fs.existsSync(c) && fs.statSync(c).isFile());
const read = (f: string) => VFS.get(f) ?? fs.readFileSync(f, 'utf8');

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('src/')) base = path.join(ROOT, spec); // tsconfig baseUrl "."
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  const noJs = base.replace(/\.[cm]?js$/, '');
  for (const c of [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((x) => `${noJs}${x}`), ...['index.ts', 'index.tsx', 'index.js'].map((x) => path.join(base, x))]) if (exists(c)) return c;
  return null;
}

/**
 * Every module specifier of a file: ts.preProcessFile (static, dynamic, require), plus the
 * literal head of a template-literal import()/require() (`../connectors/managed/${x}` is
 * treated as a reach into that directory).
 */
function imports(f: string): string[] {
  const text = read(f);
  const out = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*`([^`$]*)/g)) out.push(m[1]);
  return out;
}
const isWorkerOnly = (f: string) => (f === MANAGED || f.startsWith(`${MANAGED}${path.sep}`)) && !WEB_ALLOWED.includes(f) && !TEST.test(f);
/** A template-literal head that names a managed directory (or a prefix of a file name in it). */
function templateReach(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2)) : spec.startsWith('src/') ? path.join(ROOT, spec) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  const dir = spec.endsWith('/') ? path.resolve(base) : path.dirname(base);
  return dir === MANAGED || dir.startsWith(`${MANAGED}${path.sep}`) || `${MANAGED}${path.sep}`.startsWith(`${dir}${path.sep}`) ? dir : null;
}

/** The first worker-only managed module reachable from `entry`, or null. */
function reachesWorkerOnly(entry: string): string | null {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (isWorkerOnly(f)) return f;
    for (const s of imports(f)) {
      const r = resolveLocal(f, s);
      if (r) todo.push(r);
      else {
        const t = templateReach(f, s);
        if (t) return t;
      }
    }
  }
  return null;
}

/** Roots Next can bundle; worker code (src/ingest) and the managed tree itself are not entries. */
function bundleRoots(): Array<{ root: string; files: string[] }> {
  const notTest = (f: string) => !TEST.test(f);
  const app = (f: string) => notTest(f) && !f.startsWith(path.join(ROOT, 'src', 'ingest') + path.sep) && !f.startsWith(MANAGED + path.sep);
  const rootFiles = ['proxy', 'middleware', 'instrumentation'].flatMap((n) => ['.ts', '.tsx', '.js', '.mjs', '.mts'].map((x) => path.join(ROOT, `${n}${x}`))).filter((f) => fs.existsSync(f));
  return [
    { root: 'root files (proxy/middleware/instrumentation)', files: rootFiles },
    ...['app', 'src/app', 'pages', 'src/pages'].filter((d) => fs.existsSync(path.join(ROOT, d))).map((d) => ({ root: d, files: walk(path.join(ROOT, d)).filter(notTest) })),
    { root: 'src', files: walk(path.join(ROOT, 'src')).filter(app) },
  ];
}

describe('managed connector boundary', () => {
  it('no file Next can bundle reaches a worker-only managed module (and every scanned root is non-empty)', () => {
    const roots = bundleRoots();
    expect(roots.map((r) => r.root)).toEqual(expect.arrayContaining(['root files (proxy/middleware/instrumentation)', 'pages', 'src']));
    for (const r of roots) expect(r.files.length, `scan of ${r.root} visited no file`).toBeGreaterThan(0);
    expect(roots.find((r) => r.root === 'src')!.files.length).toBeGreaterThan(100);
    expect(roots.find((r) => r.root === 'pages')!.files.length).toBeGreaterThan(5);
    // The carve-out is used, so the scan really traverses into src/connectors/managed.
    const visited = new Set<string>();
    for (const r of roots) for (const f of r.files) for (const s of imports(f)) { const x = resolveLocal(f, s); if (x) visited.add(x); }
    expect([...visited].some((f) => WEB_ALLOWED.includes(f))).toBe(true);
    const hits = roots.flatMap((r) => r.files).flatMap((f) => {
      const hit = reachesWorkerOnly(f);
      return hit ? [`${path.relative(ROOT, f)} -> ${path.relative(ROOT, hit)}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it('the detector sees every import form, transitively (self-test)', () => {
    const fakePage = path.join(ROOT, 'pages', '__boundary_probe__.ts');
    const fakeLib = path.join(ROOT, 'src', 'lib', '__boundary_probe__.ts');
    const forms: Array<[string, string]> = [
      [`export { runManagedFetch } from '../connectors/managed/runtime';\n`, path.join(MANAGED, 'runtime.ts')],
      [`export const m = () => import('../connectors/managed/health');\n`, path.join(MANAGED, 'health.ts')],
      [`const r = require('../connectors/managed/secrets/resolve');\nexport default r;\n`, path.join(MANAGED, 'secrets', 'resolve.ts')],
      [`export const m = (x: string) => import(\`../connectors/managed/\${x}\`);\n`, MANAGED],
      [`export const m = (x: string) => import(\`@/connectors/managed/evidence/\${x}\`);\n`, path.join(MANAGED, 'evidence')],
      [`import { managedRegistry } from 'src/connectors/managed/registry';\nexport default managedRegistry;\n`, path.join(MANAGED, 'registry.ts')],
      [`export * from '@/connectors/managed/engagementSpec';\n`, path.join(MANAGED, 'engagementSpec.ts')],
      [`export * from '../connectors/managed/evidence/capture.js';\n`, path.join(MANAGED, 'evidence', 'capture.ts')],
    ];
    try {
      for (const [lib, want] of forms) {
        VFS.set(fakeLib, lib);
        VFS.set(fakePage, `import x from '@/lib/__boundary_probe__';\nexport default x;\n`);
        expect(reachesWorkerOnly(fakePage), lib).toBe(want);
      }
      // A .mts module is followed too.
      const mts = path.join(ROOT, 'src', 'lib', '__boundary_probe_m__.mts');
      VFS.set(mts, `export * from '../connectors/managed/runtime';\n`);
      VFS.set(fakePage, `export * from '../src/lib/__boundary_probe_m__.mjs';\n`);
      expect(reachesWorkerOnly(fakePage)).toBe(path.join(MANAGED, 'runtime.ts'));
      // The carve-out is not a reach; anything else under the managed tree is.
      VFS.set(fakePage, `export * from '../src/connectors/managed/pointfive/mcpClient';\n`);
      expect(reachesWorkerOnly(fakePage)).toBeNull();
      VFS.set(fakePage, `export * from '../src/connectors/managed/pointfive/fixtures/syntheticMcpServer';\n`);
      expect(reachesWorkerOnly(fakePage)).toBe(path.join(MANAGED, 'pointfive', 'fixtures', 'syntheticMcpServer.ts'));
      VFS.set(fakeLib, `export const x = 1;\n`);
      VFS.set(fakePage, `import x from '@/lib/__boundary_probe__';\nexport default x;\n`);
      expect(reachesWorkerOnly(fakePage)).toBeNull();
    } finally {
      VFS.clear();
    }
  });

  it('managed code never imports the demo parser or the costsource transports', () => {
    const offenders = walk(MANAGED)
      .filter((f) => !TEST.test(f) && !f.includes(`${path.sep}pointfive${path.sep}`))
      .flatMap((f) => imports(f).filter((s) => /costsource\/transports\/focusExport|coerceFocusRecord|costsource\/(?!.*redact)/.test(s)).map((s) => `${path.relative(ROOT, f)} -> ${s}`));
    expect(offenders).toEqual([]);
  });

  it('worker-only managed modules import nothing through the @/ alias or src/ baseUrl (the worker build has no paths)', () => {
    const files = walk(MANAGED).filter((f) => isWorkerOnly(f) && !f.includes(`${path.sep}pointfive${path.sep}`));
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.flatMap((f) => imports(f).filter((s) => s.startsWith('@/') || s.startsWith('src/')).map((s) => `${path.relative(ROOT, f)} -> ${s}`))).toEqual([]);
  });

  it('every registered connector id is one the engagement config names', () => {
    for (const id of managedRegistry.connectors()) expect(MANAGED_CONNECTORS as readonly string[]).toContain(id);
  });
});
