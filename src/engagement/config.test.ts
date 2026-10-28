// R1: the engagement config (one validated config per instance). SYNTHETIC
// example fixture only; no customer data. Invalid input is rejected by KEY
// name and the offending value is never echoed.
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate an untyped JSON document */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkEngagementStartup,
  describeSourceMetadata,
  EngagementConfigError,
  engagementMode,
  loadEngagementConfig,
  validateEngagementConfig,
  type EngagementConfig,
} from './config';
import { register } from '../../instrumentation';

const FIXTURE = path.resolve(__dirname, '../../fixtures/engagement/example/engagement.json');
const raw = (): any => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const SECRET = 'LEAKED-VALUE-9f3c';

function mutated(fn: (c: any) => void): unknown {
  const c = raw();
  fn(c);
  return c;
}
function problemsOf(input: unknown): string[] {
  const r = validateEngagementConfig(input);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.problems;
}

const tmp: string[] = [];
function writeTmp(text: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-eng-'));
  tmp.push(dir);
  const p = path.join(dir, 'engagement.json');
  fs.writeFileSync(p, text);
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('valid example', () => {
  it('validates and returns a typed config', () => {
    const r = validateEngagementConfig(raw());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c: EngagementConfig = r.config;
    expect(c.tenantId).toBe('5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d');
    expect(c.sources[0].metadata.financial.billed_cost_total).toEqual({ USD: '18.00663861840' });
    expect(c.allocation.workloadTagKey).toBe('application');
  });

  it('loader returns the config plus the sha256 of the exact file bytes (stable)', () => {
    const bytes = fs.readFileSync(FIXTURE);
    const a = loadEngagementConfig(FIXTURE);
    const b = loadEngagementConfig(FIXTURE);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(b.sha256).toBe(a.sha256);
    // Semantically identical JSON with different bytes hashes differently: the hash is of bytes.
    const p = writeTmp(JSON.stringify(JSON.parse(bytes.toString('utf8'))));
    const c = loadEngagementConfig(p);
    expect(c.ok && c.sha256 !== a.sha256).toBe(true);
  });

  it('scenario assumption defaults are filled in', () => {
    const r = validateEngagementConfig(raw());
    if (!r.ok) throw new Error('expected ok');
    expect(r.config.scenarios[0].assumptions).toMatchObject({ cachedInputShare: 0, batchShare: 0 });
  });
});

describe('each invalid field is rejected by key name, never by value', () => {
  const cases: Array<[string, string, (c: any) => void]> = [
    ['bad tenant UUID', 'tenantId', (c) => (c.tenantId = SECRET)],
    ['missing engagementId', 'engagementId', (c) => delete c.engagementId],
    ['bad engagementId', 'engagementId', (c) => (c.engagementId = `Bad ${SECRET}`)],
    ['empty displayName', 'displayName', (c) => (c.displayName = '')],
    ['bad currency', 'currency', (c) => (c.currency = SECRET)],
    ['no sources', 'sources', (c) => (c.sources = [])],
    ['duplicate source id', 'sources[1].id', (c) => c.sources.push(structuredClone(c.sources[0]))],
    ['unknown provider', 'sources[0].providers[0]', (c) => (c.sources[0].providers = [SECRET])],
    ['unknown layout', 'sources[0].layout', (c) => (c.sources[0].layout = SECRET)],
    ['unknown model', 'scenarios[0].candidateModel', (c) => (c.scenarios[0].candidateModel = SECRET)],
    ['unknown current model', 'scenarios[0].currentModel', (c) => (c.scenarios[0].currentModel = SECRET)],
    ['scenario workload not declared', 'scenarios[0].workload', (c) => (c.scenarios[0].workload = SECRET)],
    ['negative budget', 'budgets[0].monthly', (c) => (c.budgets[0].monthly = '-5.00')],
    ['zero budget', 'budgets[0].monthly', (c) => (c.budgets[0].monthly = '0')],
    ['below one cent', 'budgets[0].monthly', (c) => (c.budgets[0].monthly = '0.009')],
    ['non-decimal budget', 'budgets[0].monthly', (c) => (c.budgets[0].monthly = SECRET)],
    ['numeric budget (must be a string)', 'budgets[0].monthly', (c) => (c.budgets[0].monthly = 20)],
    ['budget for undeclared workload', 'budgets[0].workload', (c) => (c.budgets[0].workload = SECRET)],
    ['duplicate budget workload', 'budgets[1].workload', (c) => (c.budgets[1].workload = c.budgets[0].workload)],
    ['empty workloadTagKey', 'allocation.workloadTagKey', (c) => (c.allocation.workloadTagKey = '')],
    ['subAccountMap to undeclared workload', 'allocation.subAccountMap[0]', (c) => (c.allocation.subAccountMap = { [SECRET]: SECRET })],
    ['unknown shared-cost rule', 'allocation.sharedCostRules[0].rule', (c) => (c.allocation.sharedCostRules[0].rule = SECRET)],
    ['even_split without targets', 'allocation.sharedCostRules[0].targets', (c) => (c.allocation.sharedCostRules[0] = { id: 'x', rule: 'even_split' })],
    ['negative token volume', 'scenarios[0].assumptions.inputTokensPerMonth', (c) => (c.scenarios[0].assumptions.inputTokensPerMonth = -1)],
    ['share out of range', 'scenarios[0].assumptions.cachedInputShare', (c) => (c.scenarios[0].assumptions.cachedInputShare = 2)],
    ['outcomesFile not a path string', 'outcomesFile', (c) => (c.outcomesFile = 7)],
    ['unknown top-level key', 'surprise', (c) => (c.surprise = SECRET)],
    ['unknown metadata key', 'sources[0].metadata.surprise', (c) => (c.sources[0].metadata.surprise = SECRET)],
    ['unknown nested metadata key', 'sources[0].metadata.scope.surprise', (c) => (c.sources[0].metadata.scope.surprise = SECRET)],
  ];
  it.each(cases)('%s -> %s', (_n, key, mutate) => {
    const problems = problemsOf(mutated(mutate));
    expect(problems.some((p) => p.includes(key)), problems.join(' | ')).toBe(true);
    expect(problems.join(' ')).not.toContain(SECRET);
    expect(problems.join(' ')).not.toContain('-5.00');
  });

  it('the root being the wrong type is reported without echoing it', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(problemsOf(v).length).toBeGreaterThan(0);
  });
});

describe('source metadata', () => {
  const meta = (c: any) => c.sources[0].metadata;
  const cases: Array<[string, string, (c: any) => void]> = [
    ['missing provenance', 'sources[0].metadata.provenance', (c) => delete meta(c).provenance],
    ['bad provider', 'sources[0].metadata.provider', (c) => (meta(c).provider = SECRET)],
    ['bad cost_basis', 'sources[0].metadata.cost_basis', (c) => (meta(c).cost_basis = SECRET)],
    ['missing cost_basis', 'sources[0].metadata.cost_basis', (c) => delete meta(c).cost_basis],
    ['dataset over 200 chars', 'sources[0].metadata.dataset', (c) => (meta(c).dataset = 'x'.repeat(201))],
    ['missing dataset', 'sources[0].metadata.dataset', (c) => delete meta(c).dataset],
    ['bad source_role', 'sources[0].metadata.source_role', (c) => (meta(c).source_role = SECRET)],
    ['missing source_role', 'sources[0].metadata.source_role', (c) => delete meta(c).source_role],
    ['missing versions', 'sources[0].metadata.versions', (c) => delete meta(c).versions],
    ['missing version field', 'sources[0].metadata.versions.api_version', (c) => delete meta(c).versions.api_version],
    ['bad snapshot hash', 'sources[0].metadata.versions.schema_snapshot_hash', (c) => (meta(c).versions.schema_snapshot_hash = SECRET)],
    ['unknown versions key', 'sources[0].metadata.versions.version', (c) => (meta(c).versions.version = SECRET)],
    ['bad source_kind', 'sources[0].metadata.source_kind', (c) => (meta(c).source_kind = SECRET)],
    ['blank schema_version', 'sources[0].metadata.schema_version', (c) => (meta(c).schema_version = ' ')],
    ['sanitization over 500 chars', 'sources[0].metadata.sanitization', (c) => (meta(c).sanitization = 'x'.repeat(501))],
    ['bad accounts', 'sources[0].metadata.scope.accounts', (c) => (meta(c).scope.accounts = SECRET)],
    ['non-ISO period_start', 'sources[0].metadata.scope.period_start', (c) => (meta(c).scope.period_start = SECRET)],
    ['date-only period_end', 'sources[0].metadata.scope.period_end', (c) => (meta(c).scope.period_end = '2024-10-01')],
    ['start not before end', 'sources[0].metadata.scope.period_start', (c) => (meta(c).scope.period_start = meta(c).scope.period_end)],
    ['bad period_end_semantics', 'sources[0].metadata.scope.period_end_semantics', (c) => (meta(c).scope.period_end_semantics = SECRET)],
    ['bad timezone', 'sources[0].metadata.scope.timezone', (c) => (meta(c).scope.timezone = SECRET)],
    ['explicit-subset needs subset_description', 'sources[0].metadata.scope.subset_description', (c) => delete meta(c).scope.subset_description],
    ['bad completeness', 'sources[0].metadata.scope.completeness', (c) => (meta(c).scope.completeness = SECRET)],
    ['bad delivery format', 'sources[0].metadata.delivery.format', (c) => (meta(c).delivery.format = SECRET)],
    ['empty compression', 'sources[0].metadata.delivery.compression', (c) => (meta(c).delivery.compression = '')],
    ['manifest with a path', 'sources[0].metadata.delivery.manifest', (c) => (meta(c).delivery.manifest = '../x/manifest.json')],
    ['missing refresh_behavior', 'sources[0].metadata.delivery.refresh_behavior', (c) => delete meta(c).delivery.refresh_behavior],
    ['bad currency code', 'sources[0].metadata.financial.currencies[0]', (c) => (meta(c).financial.currencies = [SECRET])],
    ['no currencies', 'sources[0].metadata.financial.currencies', (c) => (meta(c).financial.currencies = [])],
    ['non-decimal billed total', 'sources[0].metadata.financial.billed_cost_total', (c) => (meta(c).financial.billed_cost_total = { USD: SECRET })],
    ['numeric effective total', 'sources[0].metadata.financial.effective_cost_total', (c) => (meta(c).financial.effective_cost_total = { USD: 13 })],
    ['total for an undeclared currency', 'sources[0].metadata.financial.billed_cost_total', (c) => (meta(c).financial.billed_cost_total = { USD: '1.0', EUR: '2.0' })],
    ['declared currency without a total', 'sources[0].metadata.financial.effective_cost_total', (c) => (meta(c).financial.currencies = ['USD', 'EUR'])],
    ['bad credits_coverage', 'sources[0].metadata.financial.credits_coverage', (c) => (meta(c).financial.credits_coverage = SECRET)],
    ['bad tax_coverage', 'sources[0].metadata.financial.tax_coverage', (c) => delete meta(c).financial.tax_coverage],
    ['bad control_total_source', 'sources[0].metadata.financial.control_total_source', (c) => (meta(c).financial.control_total_source = SECRET)],
    ['totals given but control_total_source not_available', 'sources[0].metadata.financial.control_total_source', (c) => (meta(c).financial.control_total_source = 'not_available')],
    ['missing known_differences', 'sources[0].metadata.financial.known_differences', (c) => delete meta(c).financial.known_differences],
    ['bad also_present_in_other_source', 'sources[0].metadata.overlap.also_present_in_other_source', (c) => (meta(c).overlap.also_present_in_other_source = SECRET)],
    ['yes with related_source none', 'sources[0].metadata.overlap.related_source', (c) => (meta(c).overlap = { also_present_in_other_source: 'yes', related_source: 'none' })],
    ['related_source not resolving', 'sources[0].metadata.overlap.related_source', (c) => (meta(c).overlap = { also_present_in_other_source: 'yes', related_source: SECRET })],
    ['missing related_source', 'sources[0].metadata.overlap.related_source', (c) => delete meta(c).overlap.related_source],
    ['yes with related_source naming its own source', 'sources[0].metadata.overlap.related_source', (c) => (meta(c).overlap = { also_present_in_other_source: 'yes', related_source: c.sources[0].id })],
    ['no with related_source naming its own source', 'sources[0].metadata.overlap.related_source', (c) => (meta(c).overlap = { also_present_in_other_source: 'no', related_source: c.sources[0].id })],
  ];
  it.each(cases)('%s -> %s', (_n, key, mutate) => {
    const problems = problemsOf(mutated(mutate));
    expect(problems.some((p) => p.includes(key)), problems.join(' | ')).toBe(true);
    expect(problems.join(' ')).not.toContain(SECRET);
  });

  it('accepts explicit unknown / not_available values; never defaults a blank', () => {
    const c = raw();
    Object.assign(meta(c).financial, { billed_cost_total: 'not_available', effective_cost_total: 'not_available', control_total_source: 'not_available', credits_coverage: 'unknown', tax_coverage: 'unknown' });
    meta(c).delivery.refresh_behavior = 'unknown';
    expect(validateEngagementConfig(c).ok).toBe(true);
  });

  it('a resolving related_source is accepted', () => {
    const c = raw();
    const second = structuredClone(c.sources[0]);
    second.id = 'second-source';
    second.metadata.overlap = { also_present_in_other_source: 'yes', related_source: 'aws-focus-sample' };
    c.sources.push(second);
    c.sources[0].metadata.overlap = { also_present_in_other_source: 'yes', related_source: 'second-source' };
    expect(validateEngagementConfig(c).ok).toBe(true);
  });

  it('describeSourceMetadata returns a flat, display-ready (label, value) list', () => {
    const r = validateEngagementConfig(raw());
    if (!r.ok) throw new Error('expected ok');
    const rows = describeSourceMetadata(r.config.sources[0].metadata);
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(typeof row.label).toBe('string');
      expect(typeof row.value).toBe('string');
      expect(row.value).not.toBe('');
    }
    const get = (l: string) => rows.find((x) => x.label === l)?.value;
    expect(get('Cost basis')).toBe('focus-native');
    expect(get('Dataset')).toContain('FOCUS 1.0');
    expect(get('Source role')).toBe('authoritative');
    expect(get('FOCUS version')).toBe('1.0');
    expect(get('Schema snapshot hash')).toBe('unknown');
    expect(get('Provenance')).toBe('official-example');
    expect(get('Billed cost total')).toBe('USD 18.00663861840');
    expect(get('Period end semantics')).toBe('exclusive');
    expect(get('Credits coverage')).toBe('included');
  });
});

describe('release policy (loader)', () => {
  it('source_kind api is schema-valid but not implemented in this build (names the key)', () => {
    const c = raw();
    c.sources[0].metadata.source_kind = 'api';
    expect(validateEngagementConfig(c).ok).toBe(true);
    const r = loadEngagementConfig(writeTmp(JSON.stringify(c)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toContain('sources[0].metadata.source_kind');
    expect(r.problems.join(' ')).toMatch(/not implemented in this build/);
  });

  it.each(['parquet', 'ndjson'])('delivery.format %s is schema-valid but rejected by the loader by key name', (fmt) => {
    const c = raw();
    c.sources[0].metadata.delivery.format = fmt;
    expect(validateEngagementConfig(c).ok).toBe(true);
    const r = loadEngagementConfig(writeTmp(JSON.stringify(c)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('sources[0].metadata.delivery.format');
  });

  it('csv-gzip is accepted', () => {
    const c = raw();
    c.sources[0].metadata.delivery.format = 'csv-gzip';
    c.sources[0].metadata.delivery.compression = 'gzip';
    expect(loadEngagementConfig(writeTmp(JSON.stringify(c))).ok).toBe(true);
  });

  it('missing file, unreadable path, bad JSON and relative path are rejected naming RATIO_ENGAGEMENT_CONFIG or the JSON, without echoing contents', () => {
    expect(loadEngagementConfig('/nonexistent/dir/engagement.json').ok).toBe(false);
    const bad = loadEngagementConfig(writeTmp(`{"tenantId": "${SECRET}",`));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join(' ')).not.toContain(SECRET);
    const rel = loadEngagementConfig('engagement.json');
    expect(rel.ok).toBe(false);
    if (!rel.ok) expect(rel.problems.join(' ')).toContain('RATIO_ENGAGEMENT_CONFIG');
  });

  it('rejects an otherwise valid config file over 1 MiB (valid-JSON whitespace padding), naming the size limit', () => {
    const json = JSON.stringify(raw());
    expect(loadEngagementConfig(writeTmp(json)).ok).toBe(true);
    const padded = json + ' '.repeat(1024 * 1024 + 1 - Buffer.byteLength(json));
    expect(Buffer.byteLength(padded)).toBe(1024 * 1024 + 1);
    expect(() => JSON.parse(padded)).not.toThrow();
    expect(validateEngagementConfig(JSON.parse(padded)).ok).toBe(true);
    const r = loadEngagementConfig(writeTmp(padded));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(['RATIO_ENGAGEMENT_CONFIG: file is larger than 1 MiB']);
  });

  it('a config file of exactly 1 MiB (valid-JSON padding) is accepted', () => {
    const json = JSON.stringify(raw());
    expect(loadEngagementConfig(writeTmp(json + ' '.repeat(1024 * 1024 - Buffer.byteLength(json)))).ok).toBe(true);
  });
});

describe('retrieval', () => {
  const withRetrieval = (r: unknown) => mutated((c) => (c.sources[0].retrieval = r));
  const managed = (extra: any = {}) => ({ kind: 'managed', connector: 'aws-data-exports', params: { bucket: 'b', prefixes: ['a', 'b'], nested: { n: 1 } }, secretRef: 'AWS_READER_SECRET', ...extra });

  it('defaults to file-drop when absent', () => {
    const r = validateEngagementConfig(raw());
    if (!r.ok) throw new Error('expected ok');
    expect(r.config.sources[0].retrieval).toEqual({ kind: 'file-drop' });
  });

  it('managed retrieval is schema-valid but not implemented in this build (single place)', () => {
    const c = raw();
    c.sources[0].retrieval = managed();
    expect(validateEngagementConfig(c).ok).toBe(true);
    const r = loadEngagementConfig(writeTmp(JSON.stringify(c)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toMatch(/sources\[0\]\.retrieval\.kind: not implemented in this build/);
  });

  it('every connector name is accepted by the schema', () => {
    for (const connector of ['aws-data-exports', 'azure-cost-export', 'gcp-bigquery-export', 'oci-cost-report', 'nutanix', 'servicenow', 'pointfive', 'opencost', 'openai-usage', 'anthropic-usage'])
      expect(validateEngagementConfig(withRetrieval(managed({ connector }))).ok, connector).toBe(true);
  });

  const bad: Array<[string, string, unknown]> = [
    ['unknown kind', 'sources[0].retrieval.kind', { kind: SECRET }],
    ['unknown connector', 'sources[0].retrieval.connector', managed({ connector: SECRET })],
    ['unknown block key', 'sources[0].retrieval.surprise', managed({ surprise: 1 })],
    ['file-drop with connector', 'sources[0].retrieval.connector', { kind: 'file-drop', connector: 'nutanix' }],
    ['params not an object', 'sources[0].retrieval.params', managed({ params: 'x' })],
    ['params value of wrong type', 'sources[0].retrieval.params.bad', managed({ params: { bad: null } })],
    ['params nested too deep', 'sources[0].retrieval.params.a.b', managed({ params: { a: { b: { c: 1 } } } })],
    ['secretRef holding a value', 'sources[0].retrieval.secretRef', managed({ secretRef: 'x'.repeat(48) })],
    ['secretRef with spaces', 'sources[0].retrieval.secretRef', managed({ secretRef: `has space ${SECRET}` })],
    ['PEM in params', 'sources[0].retrieval.params.key', managed({ params: { key: `-----BEGIN PRIVATE KEY-----${SECRET}` } })],
    ['JWT in params', 'sources[0].retrieval.params.t', managed({ params: { t: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-def_ghi' } })],
    ['long hex in params list', 'sources[0].retrieval.params.l[0]', managed({ params: { l: ['a'.repeat(64)] } })],
    ['access key id in params', 'sources[0].retrieval.params.k', managed({ params: { k: 'AKIAABCDEFGHIJKLMNOP' } })],
  ];
  it.each(bad)('%s -> %s', (_n, key, r) => {
    const problems = problemsOf(withRetrieval(r));
    expect(problems.some((p) => p.includes(key)), problems.join(' | ')).toBe(true);
    const all = problems.join(' ');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(all).not.toContain('eyJhbGci');
  });
});

describe('mode and startup', () => {
  const GOOD = { RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE } as const;

  it('engagementMode: only the exact value engagement selects it; empty/unset is off; anything else is an error', () => {
    expect(engagementMode({})).toBe(false);
    expect(engagementMode({ RATIO_MODE: '' })).toBe(false);
    expect(engagementMode({ RATIO_MODE: 'engagement' })).toBe(true);
    expect(() => engagementMode({ RATIO_MODE: 'Engagement' })).toThrow(/RATIO_MODE/);
  });

  it('non-engagement mode: no-op, the config path is not even read', () => {
    expect(checkEngagementStartup({})).toBeNull();
    expect(checkEngagementStartup({ RATIO_ENGAGEMENT_CONFIG: '/nonexistent' })).toBeNull();
  });

  it('engagement mode with a valid config returns config + sha256', () => {
    const r = checkEngagementStartup({ ...GOOD });
    expect(r?.config.engagementId).toBe('example-focus-sample');
    expect(r?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('engagement mode without RATIO_ENGAGEMENT_CONFIG throws naming the variable', () => {
    expect(() => checkEngagementStartup({ RATIO_MODE: 'engagement' })).toThrow(/RATIO_ENGAGEMENT_CONFIG/);
    expect(() => checkEngagementStartup({ RATIO_MODE: 'engagement' })).toThrow(EngagementConfigError);
  });

  it('engagement mode with an invalid config: register() logs only the problem keys and exits non-zero', async () => {
    const c = raw();
    c.tenantId = SECRET;
    c.budgets[0].monthly = '-1';
    const p = writeTmp(JSON.stringify(c));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'engagement');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', p);
    // Injected exit: the real process.exit would end the test worker.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logged: string[] = [];
    const capture = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    try {
      await register();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const all = logged.join('\n');
    expect(all).toContain('tenantId');
    expect(all).toContain('budgets[0].monthly');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('-1');
    expect(all).not.toContain(p);
  });

  it('register() with a valid engagement config resolves', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'engagement');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', FIXTURE);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(register()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('register() outside engagement mode is unchanged (no throw even with a bad config path)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', '/nonexistent');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await expect(register()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('register() with an invalid RATIO_MODE is unchanged: it rejects, it does not exit', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'Engagement');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await expect(register()).rejects.toThrow(/RATIO_MODE/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('tenant UUID rule', () => {
  // config.ts duplicates the canonical-UUID regex of src/ingest/db/tenant.ts (it may not
  // import src/ingest). This guards the copy against drift.
  const literal = (rel: string): string => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
    const m = src.match(/^const UUID_RE = (\/.+\/[a-z]*);$/m);
    if (!m) throw new Error(`UUID_RE literal not found in ${rel}`);
    return m[1];
  };

  it('the engagement UUID_RE is identical to src/ingest/db/tenant.ts', () => {
    expect(literal('src/engagement/config.ts')).toBe(literal('src/ingest/db/tenant.ts'));
  });

  it('the validator accepts and rejects the same tenant ids as the tenant.ts rule', () => {
    // Built from tenant.ts's source text: importing src/ingest here would break the import boundary.
    const lit = literal('src/ingest/db/tenant.ts');
    const re = new RegExp(lit.slice(1, lit.lastIndexOf('/')), lit.slice(lit.lastIndexOf('/') + 1));
    const isTenantId = (v: string) => re.test(v);
    const samples = ['5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d', '5F0C1A7E-2B3D-4C5E-8F60-71829A3B4C5D', '5f0c1a7e2b3d4c5e8f6071829a3b4c5d', ' 5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d', '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5g', ''];
    for (const t of samples) {
      const c = raw();
      c.tenantId = t;
      expect(validateEngagementConfig(c).ok, t).toBe(isTenantId(t));
    }
  });
});
