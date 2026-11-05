// Schema pins and the module boundary. Each schemaVersion pins the sha256 of its validator's canonical description
// (keys, optionality, rules). Changing what a contract accepts without a new schemaVersion fails here; a new version
// must add its own pin and keep reading the old one until a migration test retires it (ADR-0001 §4.5).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CONTRACT_MARKERS } from '../../../scripts/check-next-bundle.mjs';
import * as contracts from './index';

const BY_VERSION: Record<contracts.SchemaVersion, { desc: string }> = {
  'ai-usage-event/1': contracts.validateAIUsageEvent, 'ai-financial-record/1': contracts.validateFinancialRecord, 'rate-card/1': contracts.validateRateCard,
  'allocation/1': contracts.validateAllocation, 'activity-event/1': contracts.validateActivityEvent, 'eligibility-snapshot/1': contracts.validateEligibilitySnapshot,
  'adoption-definition/1': contracts.validateAdoptionDefinition, 'entitlement/1': contracts.validateEntitlement, 'policy/1': contracts.validatePolicy,
  'policy-bundle/1': contracts.validatePolicyBundle, 'policy-decision/1': contracts.validatePolicyDecision, 'gateway-request/1': contracts.validateGatewayRequestRecord,
  'connector-declaration/1': contracts.validateConnectorDeclaration,
};

const PINS: Record<contracts.SchemaVersion, string> = {
  'ai-usage-event/1': 'd0b744abbf28e2a19d4e8d7aa8e46a72caf15972c2c1a29051e8cf76b405caa4',
  'ai-financial-record/1': 'e6cc7d77d1f131754663220d92a147e5ef4e649d3b8593bc8d6126f2d8a4b935',
  'rate-card/1': '57b46f2c7d3260c03a529a7b65cb057b4e316a08de5c85a7c004f26cccbf8c65',
  'allocation/1': 'f23b8ec98b90efcc25a260b585721ba935261885f61a989368690c3ad1d34888',
  'activity-event/1': 'a7417cf9db6d39d1de5bf8f3f04e3152bca1b844b08178cee1b365536c5a80d9',
  'eligibility-snapshot/1': '3ebc2d32ce22083963ab7126faff14062480a40d7a4153bdd62d0e5c414d41ce',
  'adoption-definition/1': 'df56a85b0f54144211fe42c769703bcffc35393f248b9b8df2ba265b2ada0770',
  'entitlement/1': 'ac38e0f2d5784c8579f6e8f3d6f2c628100c06455dbcffc4c0d2f18499dde562',
  'policy/1': '57633086f3057a7be6b5fa941d9b42969b588db208fa55079942aeb0dd7a930a',
  'policy-bundle/1': '83e0f54a60eb0be92af422778029d9533ecf6aa7285a076b4a0a16c29945fa59',
  'policy-decision/1': '5bac7171e509c5dd877c72937b890ed442daede8650e96839954ab259770dcf5',
  'gateway-request/1': '52fd6c21c0cea5d56a8d7cfe1a98772e18d825ef351543f96e9481a3220a33c9',
  'connector-declaration/1': '4e88fecaf3b8075887ef7543ca27f6a7f840e001ba682ccceb5fa3d339a81043',
};

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('schema version pins', () => {
  it('every contract shape matches the pin of its schemaVersion', () => {
    const actual = Object.fromEntries(contracts.SCHEMA_VERSIONS.map((v) => [v, sha(BY_VERSION[v].desc)]));
    expect(actual).toEqual(PINS);
  });
  it('each validator requires its own schemaVersion literal', () => {
    for (const v of contracts.SCHEMA_VERSIONS) expect(BY_VERSION[v].desc).toContain(`schemaVersion:equals ${v}`);
  });
  it('check:bundle forbids a subset of these schema versions in client files', () => {
    for (const m of PLATFORM_CONTRACT_MARKERS) expect(contracts.SCHEMA_VERSIONS as readonly string[]).toContain(m);
  });
});

const DIR = __dirname;
const prod = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const specs = (file: string) => ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);

describe('platform contracts boundary', () => {
  it('has exactly these modules, importing only each other and the pure decimal helper', () => {
    expect(prod.sort()).toEqual(['adoption.ts', 'connector.ts', 'economics.ts', 'index.ts', 'policy.ts', 'validate.ts', 'versions.ts']);
    for (const f of prod) for (const s of specs(path.join(DIR, f))) expect(`${f} -> ${s}`).toMatch(/ -> \.\/(validate|versions|economics|adoption|policy|connector)$| -> \.\.\/\.\.\/finops\/semantic\/decimal$/);
  });
  it('uses no I/O, clock, network, environment, dynamic code or float on money', () => {
    const banned = [/\bparseFloat\b/, /\bNumber\(/, /\.toFixed\(/, /Math\.(round|floor|ceil)/, /\bDate\b/, /\bfetch\(/, /\beval\(/, /new Function/, /process\./, /require\(/, /\bimport\(/, /from '(pg|fs|net|http|https|crypto)'/];
    for (const f of prod) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const re of banned) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
  it('no client-side source imports the contracts: pages outside pages/api, React modules, components and the store', () => {
    // The authority is check:bundle (B7 markers); this source scan catches the obvious case before a build.
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
    const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
    const clientSide = (r: string) => (r.startsWith('pages/') && !r.startsWith('pages/api/')) || r.endsWith('.tsx') || /^src\/(components|store)\//.test(r);
    const offenders = files.map(rel).filter((r) => clientSide(r) && specs(path.join(ROOT, r)).some((s) => /platform\/contracts/.test(s)));
    expect(offenders).toEqual([]);
  });
  it('the fixtures are labeled SYNTHETIC', () => {
    expect(fs.readFileSync(path.join(DIR, 'testing', 'fixtures.ts'), 'utf8').split('\n')[0]).toMatch(/^\/\/ SYNTHETIC test fixtures/);
  });
});
