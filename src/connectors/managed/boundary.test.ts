// M0a boundary (owner directive E3, defect D1/D4): managed connectors run only
// in the worker. No web code (pages/**, or app src outside the worker and the
// managed tree) may reach the managed runtime, registry, health, secrets or
// evidence modules, statically or transitively; and managed code never uses the
// demo parser (float money, invented zeros).
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MANAGED_CONNECTORS } from '../../engagement/config';
import { managedRegistry } from './registry';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANAGED = path.join(ROOT, 'src', 'connectors', 'managed');
const WORKER_ONLY = ['registry.ts', 'runtime.ts', 'health.ts', 'secrets', 'evidence'].map((p) => path.join(MANAGED, p));
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) if (exists(c)) return c;
  return null;
}

const imports = (f: string) => ts.preProcessFile(read(f), true, true).importedFiles.map((i) => i.fileName);
const isWorkerOnly = (f: string) => WORKER_ONLY.some((w) => f === w || f.startsWith(`${w}${path.sep}`));

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
    }
  }
  return null;
}

describe('managed connector boundary', () => {
  it('no pages/** file and no app module outside src/ingest and the managed tree reaches the worker-only managed modules', () => {
    // Test files are not web code (some drive the worker CLI through the ingest test harness).
    const app = (f: string) => !/\.test\.tsx?$/.test(f) && !f.startsWith(path.join(ROOT, 'src', 'ingest') + path.sep) && !f.startsWith(MANAGED + path.sep);
    const entries = [...walk(path.join(ROOT, 'pages')).filter((f) => !/\.test\.tsx?$/.test(f)), ...walk(path.join(ROOT, 'src')).filter(app), path.join(ROOT, 'instrumentation.ts')];
    expect(entries.length).toBeGreaterThan(100);
    const hits = entries.flatMap((f) => {
      const r = reachesWorkerOnly(f);
      return r ? [`${path.relative(ROOT, f)} -> ${path.relative(ROOT, r)}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it('the detector sees a transitive import (self-test)', () => {
    const fakePage = path.join(ROOT, 'pages', '__boundary_probe__.ts');
    const fakeLib = path.join(ROOT, 'src', 'lib', '__boundary_probe__.ts');
    VFS.set(fakeLib, `export { runManagedFetch } from '../connectors/managed/runtime';\n`);
    VFS.set(fakePage, `import { runManagedFetch } from '@/lib/__boundary_probe__';\nexport default runManagedFetch;\n`);
    try {
      expect(reachesWorkerOnly(fakePage)).toBe(path.join(MANAGED, 'runtime.ts'));
      VFS.set(fakeLib, `export const x = 1;\n`);
      expect(reachesWorkerOnly(fakePage)).toBeNull();
    } finally {
      VFS.clear();
    }
  });

  it('managed code never imports the demo parser or the costsource transports', () => {
    const offenders = walk(MANAGED)
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}pointfive${path.sep}`))
      .flatMap((f) => imports(f).filter((s) => /costsource\/transports\/focusExport|coerceFocusRecord|costsource\/(?!.*redact)/.test(s)).map((s) => `${path.relative(ROOT, f)} -> ${s}`));
    expect(offenders).toEqual([]);
  });

  it('worker-only managed modules import nothing through the @/ alias (the worker build has no paths)', () => {
    const files = WORKER_ONLY.flatMap((w) => (fs.existsSync(w) && fs.statSync(w).isDirectory() ? walk(w) : [w])).filter((f) => !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.flatMap((f) => imports(f).filter((s) => s.startsWith('@/')).map((s) => `${path.relative(ROOT, f)} -> ${s}`))).toEqual([]);
  });

  it('every registered connector id is one the engagement config names', () => {
    for (const id of managedRegistry.connectors()) expect(MANAGED_CONNECTORS as readonly string[]).toContain(id);
  });
});
