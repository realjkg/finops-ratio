// The conformance mocks are TEST-ONLY (ADR-0001 §5): no app, worker, script or client module imports them, the worker
// build does not compile them, and check:bundle refuses their marker in every client and server file of a build.
import fs from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CLIENT_FORBIDDEN, TEST_ONLY_MARKERS } from '../../../scripts/check-next-bundle.mjs';
import { CONFORMANCE_MARKER } from './mockProviders';

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..', '..');
const isTest = (f: string) => /\.test\.(ts|tsx|mjs|js)$/.test(f);
const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !isTest(f)).sort();
/** A text scan for any reference to the mocks (catches bare baseUrl, template-literal and dynamic imports); check:bundle rule 8 is the backstop on builds. */
const mentionsMocks = (text: string) => {
  const joined = text.replace(/(['"`])\s*\+\s*(['"`])/g, ''); // 'a' + 'b' reads as 'ab' (string-concatenated paths)
  const norm = joined.replace(/\/(\.\/)+/g, '/').replace(/\/{2,}/g, '/'); // ./ and // segments removed
  return /conformance\/(mock|\$\{)|\$\{["'`]conformance["'`]\}/.test(norm);
};
const imports = (file: string) => ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);

describe('conformance mocks are test-only', () => {
  it('have exactly these modules, importing only node built-ins, the contracts, the policy library and each other', () => {
    expect(prod).toEqual(['mockGateway.ts', 'mockProviders.ts', 'surfaceParams.ts']);
    for (const f of prod) for (const s of imports(path.join(DIR, f))) expect(`${f} -> ${s}`).toMatch(/ -> (node:(http|crypto|buffer|net)|\.\/mockProviders|\.\/surfaceParams|\.\.\/contracts|\.\.\/policy)$/);
  });
  it('the text scan catches every import form: relative, @/ alias, bare baseUrl, template-literal and dynamic imports, require', () => {
    for (const planted of ["import { x } from '../platform/conformance/mockGateway';", "import x from '@/platform/conformance/mockProviders';", "import x from 'src/platform/conformance/mockGateway';",
      'const m = await import(`./platform/${"conformance"}/mockGateway`);', "const m = await import(`../platform/conformance/${name}`);", "require('./platform/conformance/mockProviders')",
      "import('./platform/con' + 'formance/mockGateway')", 'import(`../platform/` + `conformance` + `/mockProviders`)', "import('../platform/conformance/./mockProviders')", "import('../x/../platform/conformance//mockGateway')"]) {
      expect(mentionsMocks(planted), planted).toBe(true);
    }
    expect(mentionsMocks("import { evaluate } from '../platform/policy';")).toBe(false);
  });
  it('no non-test module of the app, worker, scripts or client imports them', () => {
    const files: string[] = [];
    const inside = (f: string) => f.startsWith(DIR + path.sep);
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (!['node_modules', '.next', 'dist-worker'].includes(e.name)) walk(abs); } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !isTest(e.name)) files.push(abs);
      }
    };
    for (const d of ['src', 'pages', 'scripts']) walk(path.join(ROOT, d));
    // Root modules Next or Node load directly (proxy.ts, instrumentation.ts, middleware.ts, configs).
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) if (e.isFile() && /\.(ts|tsx|mjs|js|cjs)$/.test(e.name) && !isTest(e.name)) files.push(path.join(ROOT, e.name));
    expect(files.filter((f) => !inside(f) && mentionsMocks(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))).toEqual([]);
    const offenders = files.filter((f) => !inside(f)).flatMap((f) => imports(f)
      .filter((s) => s.startsWith('.') || s.startsWith('@/'))
      .map((s) => (s.startsWith('@/') ? path.join(ROOT, 'src', s.slice(2)) : path.resolve(path.dirname(f), s)))
      .filter((abs) => abs === DIR || inside(abs)).map(() => path.relative(ROOT, f)));
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
  it('the worker build does not compile them', () => {
    const include: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.worker.json'), 'utf8')).include;
    expect(include.filter((p) => p.startsWith('src/platform/'))).toEqual(['src/platform/contracts/*.ts', 'src/platform/policy/*.ts']);
  });
  it('plant test: a minified, tree-shaken bundle of either mock carries the marker check:bundle refuses in client and server files', () => {
    expect(TEST_ONLY_MARKERS).toEqual([CONFORMANCE_MARKER]);
    expect(CLIENT_FORBIDDEN).toContain(CONFORMANCE_MARKER);
    for (const contents of ["import { createMockGateway } from './mockGateway'; console.log(createMockGateway);", "import { startMockProvider } from './mockProviders'; console.log(startMockProvider);"]) {
      const text = buildSync({ stdin: { contents, resolveDir: DIR, loader: 'ts' }, bundle: true, minify: true, treeShaking: true, write: false, platform: 'node', format: 'esm' }).outputFiles[0].text;
      expect(text).toContain(CONFORMANCE_MARKER);
    }
  });
});
