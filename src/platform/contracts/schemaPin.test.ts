// Schema pins, the golden corpus, supported versions and the module boundary (ADR-0001 §4.5).
// - Pin: sha256 of each validator's canonical description (structure, enums, rule ids `name@version`; not labels).
// - Corpus: corpus/<name>.<major>.json, hand-reviewed accept/reject cases with the problem paths; a change in what a
//   contract accepts fails here unless the case is changed in review, which is a contract change (new major).
// - Every supported version keeps its pin and its corpus until its reader is removed.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CLIENT_FORBIDDEN, PLATFORM_CONTRACT_MARKERS } from '../../../scripts/check-next-bundle.mjs';
import * as contracts from './index';

type Validate = ((v: unknown) => { ok: boolean; problems?: string[] }) & { desc: string };
const BY_VERSION: Record<contracts.SchemaVersion, Validate> = {
  'ai-usage-event/1': contracts.validateAIUsageEvent, 'ai-financial-record/1': contracts.validateFinancialRecord, 'rate-card/1': contracts.validateRateCard,
  'allocation/1': contracts.validateAllocation, 'activity-event/1': contracts.validateActivityEvent, 'eligibility-snapshot/1': contracts.validateEligibilitySnapshot,
  'adoption-definition/1': contracts.validateAdoptionDefinition, 'entitlement/1': contracts.validateEntitlement, 'policy/1': contracts.validatePolicy,
  'policy-bundle/1': contracts.validatePolicyBundle, 'policy-decision/1': contracts.validatePolicyDecision, 'gateway-request/1': contracts.validateGatewayRequestRecord,
  'connector-declaration/1': contracts.validateConnectorDeclaration,
};

const PINS: Record<contracts.SchemaVersion, string> = {
  'ai-usage-event/1': '9ce1d72a562741ed31f050e631539aab8a488e194b3b06ca2113f8a46910489c',
  'ai-financial-record/1': '34ac598676ffe4b3ee5f95d905da04c8bbec52be694e4256407741d3a3849636',
  'rate-card/1': 'a074c1d117a366f2565fc0a23691979535587e509bae2b449354059f2ea6bb2e',
  'allocation/1': '2278a725fd08d6f6719dabde8d21ae37b4a02a39081e04a7f9c68460ffe83158',
  'activity-event/1': '8e8b0017fa42d09fb0f336e931600dea26651c525f5e28f1dbccbd1753e5259e',
  'eligibility-snapshot/1': '5f95a98372bf91834f7f9c4df0c6a7630d250630764ac0a20eed767cd3b74ab1',
  'adoption-definition/1': 'c055abd748cb6ceb0795b8d31a12b2496726fd05a59a5d87613a84d67bb6202b',
  'entitlement/1': '820095061f145835f69a358c258df35f94115d6762f57e713341fdb68ad2046f',
  'policy/1': 'b5786a35c927ec0e6a33fe6c9ad1ba4147460b1a380b78491d2179ffe90632ea',
  'policy-bundle/1': '8acedd8ed44c31422f954b1f007dc6772f3c54e6f4f871f802243cfce2306f39',
  'policy-decision/1': '669edad36a0b0316b182636f26e30f00c82c2804e55c136adb15cfd5404c8ae3',
  'gateway-request/1': '337d8e8636da18cf3f204f771d8780c76ab49f70ec8addc372f25ecdccc12dec',
  'connector-declaration/1': 'b0af3acc1d4b188b53d757e91da1c88bed89c6b5e0127a70ace64ecc6c72339d',
};

const DIR = __dirname;
const CORPUS = path.join(DIR, 'corpus');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
interface Case { name: string; ok: boolean; paths: string[]; value: unknown }
const corpus = (v: string): { schemaVersion: string; note: string; cases: Case[] } => JSON.parse(fs.readFileSync(path.join(CORPUS, `${v.replace('/', '.')}.json`), 'utf8'));
const pathsOf = (problems: string[] = []) => [...new Set(problems.map((p) => p.slice(0, p.indexOf(': '))))].sort();

describe('schema version pins and the golden corpus', () => {
  it('every contract shape matches the pin of its schemaVersion', () => {
    const actual = Object.fromEntries(contracts.SCHEMA_VERSIONS.map((v) => [v, sha(BY_VERSION[v].desc)]));
    expect(actual).toEqual(PINS);
  });
  it('each validator requires its own schemaVersion literal', () => {
    for (const v of contracts.SCHEMA_VERSIONS) expect(BY_VERSION[v].desc).toContain(`schemaVersion:eq:${v}`);
  });
  for (const v of contracts.SCHEMA_VERSIONS) {
    it(`${v}: every corpus case is accepted or rejected exactly as reviewed, at the reviewed paths`, () => {
      const c = corpus(v);
      expect(c.schemaVersion).toBe(v);
      for (const k of c.cases) {
        const r = BY_VERSION[v](k.value);
        expect({ name: k.name, ok: r.ok, paths: pathsOf(r.problems) }).toEqual({ name: k.name, ok: k.ok, paths: k.paths });
      }
    });
  }
  it('every supported version has a pin and a corpus with accepted and rejected cases; nothing else is pinned', () => {
    const files = fs.readdirSync(CORPUS).sort();
    expect(files).toEqual(contracts.SCHEMA_VERSIONS.map((v) => `${v.replace('/', '.')}.json`).sort());
    expect(Object.keys(PINS).sort()).toEqual([...contracts.SCHEMA_VERSIONS].sort());
    for (const v of contracts.SCHEMA_VERSIONS) {
      const c = corpus(v);
      expect(c.note).toMatch(/^SYNTHETIC golden corpus/);
      expect(c.cases.some((k) => k.ok) && c.cases.some((k) => !k.ok), v).toBe(true);
      expect(new Set(c.cases.map((k) => k.name)).size, `${v} case names are unique`).toBe(c.cases.length);
    }
  });
  it('check:bundle forbids every schema version and the contracts origin marker in client files', () => {
    for (const m of [...contracts.SCHEMA_VERSIONS, contracts.CONTRACTS_ORIGIN]) expect(PLATFORM_CONTRACT_MARKERS).toContain(m);
  });
});

const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const specs = (file: string) => ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);

/** Files that import a seed, directly or through any chain of re-exports and imports. */
function taint(imports: Map<string, string[]>, seeds: Iterable<string>): Set<string> {
  const out = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const [f, deps] of imports) if (!out.has(f) && deps.some((d) => out.has(d))) { out.add(f); grew = true; }
  }
  return out;
}

describe('platform contracts boundary', () => {
  it('has exactly these modules, importing only each other and the pure decimal helper', () => {
    expect(prod.sort()).toEqual(['adoption.ts', 'connector.ts', 'economics.ts', 'index.ts', 'iso4217.ts', 'origin.ts', 'policy.ts', 'validate.ts', 'versions.ts']);
    for (const f of prod) for (const s of specs(path.join(DIR, f))) expect(`${f} -> ${s}`).toMatch(/ -> \.\/(validate|versions|economics|adoption|policy|connector|iso4217|origin)$| -> \.\.\/\.\.\/finops\/semantic\/decimal$/);
  });
  it('uses no I/O, clock, network, environment, dynamic code or float on money', () => {
    const banned = [/\bparseFloat\b/, /\bNumber\(/, /\.toFixed\(/, /Math\.(round|floor|ceil)/, /\bDate\b/, /\bfetch\(/, /\beval\(/, /new Function/, /process\./, /require\(/, /\bimport\(/, /from '(pg|fs|net|http|https|crypto)'/];
    for (const f of prod) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const re of banned) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
  it('plant test: a minified, tree-shaken client bundle of the ISO list, a rule, a validator or the versions carries a client-forbidden marker', () => {
    const entries: Record<string, string> = {
      iso4217: "import { ISO_4217 } from './iso4217'; console.log(ISO_4217.has('USD'));",
      rule: "import { C } from './validate'; console.log(C.money);",
      validator: "import { validateEntitlement } from './index'; console.log(validateEntitlement({}).ok);",
      versions: "import { SCHEMA_VERSIONS } from './versions'; console.log(SCHEMA_VERSIONS.length);",
    };
    for (const [name, contents] of Object.entries(entries)) {
      const out = buildSync({ stdin: { contents, resolveDir: DIR, loader: 'ts' }, bundle: true, minify: true, treeShaking: true, write: false, platform: 'browser', format: 'esm' });
      const text = out.outputFiles[0].text;
      expect(CLIENT_FORBIDDEN.some((m: string) => text.includes(m)), `${name} bundle has a client-forbidden marker`).toBe(true);
    }
  });
  it('the taint closure follows re-export chains', () => {
    const g = new Map([['lib/reexport.ts', ['contracts/index.ts']], ['ui/Panel.tsx', ['lib/reexport.ts']], ['ui/Other.tsx', ['lib/plain.ts']], ['lib/plain.ts', []]]);
    expect([...taint(g, ['contracts/index.ts'])].sort()).toEqual(['contracts/index.ts', 'lib/reexport.ts', 'ui/Panel.tsx']);
  });
  it('no client-side source reaches the contracts, directly or through re-exports (pages outside pages/api, React modules, components, store)', () => {
    // A source-level guard before a build; the authority is check:bundle (rule 7 markers, test B7).
    const ROOT = path.resolve(DIR, '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(abs);
      }
    };
    walk(path.join(ROOT, 'pages'));
    walk(path.join(ROOT, 'src'));
    const resolve = (from: string, spec: string) => {
      const base = spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
      if (!base) return null;
      for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
      return null;
    };
    const imports = new Map(files.map((f) => [f, specs(f).map((s) => resolve(f, s)).filter((x): x is string => x !== null)]));
    const tainted = taint(imports, files.filter((f) => f.startsWith(DIR + path.sep)));
    expect(tainted.size).toBeGreaterThanOrEqual(prod.length);
    const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
    const clientSide = (r: string) => (r.startsWith('pages/') && !r.startsWith('pages/api/')) || r.endsWith('.tsx') || /^src\/(components|store)\//.test(r);
    expect([...tainted].map(rel).filter(clientSide)).toEqual([]);
  });
  it('the fixtures are labeled SYNTHETIC', () => {
    expect(fs.readFileSync(path.join(DIR, 'testing', 'fixtures.ts'), 'utf8').split('\n')[0]).toMatch(/^\/\/ SYNTHETIC test fixtures/);
  });
});
