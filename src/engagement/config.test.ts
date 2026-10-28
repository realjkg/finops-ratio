// R1: the engagement config (one validated config per instance). SYNTHETIC
// example fixture only; no customer data. Invalid input is rejected by KEY
// name and the offending value is never echoed.
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
import { checkPublishedCostsStartup, publishedCostsConfig } from '@/server/costs/config';
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
    expect(get('Provenance')).toBe('official-example');
    expect(get('Billed cost total')).toBe('USD 18.00663861840');
    expect(get('Period end semantics')).toBe('exclusive');
    expect(get('Credits coverage')).toBe('included');
  });
});

describe('release policy (loader)', () => {
  it('source_kind api is schema-valid but refused by the loader with a clear message', () => {
    const c = raw();
    c.sources[0].metadata.source_kind = 'api';
    expect(validateEngagementConfig(c).ok).toBe(true);
    const r = loadEngagementConfig(writeTmp(JSON.stringify(c)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toContain('sources[0].metadata.source_kind');
    expect(r.problems.join(' ')).toMatch(/not supported in this release/);
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

  it('rejects a config file with duplicate-looking oversize input (over 1 MiB)', () => {
    const r = loadEngagementConfig(writeTmp(Buffer.alloc(1024 * 1024 + 1, 0x20)));
    expect(r.ok).toBe(false);
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
  });

  it('engagement mode with an invalid config makes register() throw, naming keys, not values', async () => {
    const c = raw();
    c.tenantId = SECRET;
    c.budgets[0].monthly = '-1';
    const p = writeTmp(JSON.stringify(c));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'engagement');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', p);
    try {
      await register();
      throw new Error('register() did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EngagementConfigError);
      const m = (e as Error).message;
      expect(m).toContain('tenantId');
      expect(m).toContain('budgets[0].monthly');
      expect(m).not.toContain(SECRET);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('register() with a valid engagement config resolves', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_MODE', 'engagement');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', FIXTURE);
    try {
      await expect(register()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('register() outside engagement mode is unchanged (no throw even with a bad config path)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('RATIO_ENGAGEMENT_CONFIG', '/nonexistent');
    try {
      await expect(register()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('reader tenant binding', () => {
  const URL_ = 'postgres://reader@127.0.0.1:1/ratio';
  const TENANT = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';

  it('engagement mode: the tenant comes from the config file', () => {
    expect(publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE, RATIO_READER_DATABASE_URL: URL_ })).toEqual({ ok: true, tenantId: TENANT, readerUrl: URL_ });
  });

  it('engagement mode: a separate RATIO_API_TENANT_ID is refused (names the variable)', () => {
    const r = publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('RATIO_API_TENANT_ID');
  });

  it('engagement mode: an invalid config fails closed (never ok), reader URL still required', () => {
    expect(publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: '/nonexistent', RATIO_READER_DATABASE_URL: URL_ }).ok).toBe(false);
    const r = publishedCostsConfig({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('RATIO_READER_DATABASE_URL');
  });

  it('engagement mode: the published-costs startup check is never silent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkPublishedCostsStartup({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: FIXTURE })).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('non-engagement mode is unchanged: env tenant still binds', () => {
    expect(publishedCostsConfig({ RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: URL_ })).toEqual({ ok: true, tenantId: TENANT, readerUrl: URL_ });
    expect(publishedCostsConfig({ RATIO_READER_DATABASE_URL: URL_ }).ok).toBe(false);
  });
});
