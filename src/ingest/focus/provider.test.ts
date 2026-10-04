// Issue #62 (U1): the per-source-type ProviderName allowlist, the
// PROVIDER_MISMATCH reason and the synthetic-provider opt-in (orchestrator
// decision D1, 2026-10-04). Pure; no database. DESIGN: docs/evidence/issue-62/DESIGN.md.
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_MISMATCH,
  SOURCE_TYPE_PROVIDERS,
  SYNTHETIC_PROVIDERS,
  checkProviderHeader,
  checkProviderName,
  providerPolicyFor,
  type ProviderPolicy,
} from './provider';
import { indexHeader } from './validate';
import { FOCUS_HEADER } from '../testing/focusCsv';

const AWS_SOURCE = { kind: 'focus_file', config: { layout: 'aws-data-exports', bucket: 'b', prefix: '', exportName: 'x' } };
const OFF = { allowSyntheticProviders: false };
const ON = { allowSyntheticProviders: true };

function awsPolicy(opts = OFF): ProviderPolicy {
  const p = providerPolicyFor(AWS_SOURCE, opts);
  if (!p) throw new Error('an aws-data-exports source must resolve a provider policy');
  return p;
}

function headerIndex(cols: readonly string[]) {
  const r = indexHeader([...cols]);
  if (!r.ok) throw new Error('header should be valid');
  return r.index;
}

describe('U1 the allowlist per source type', () => {
  it('is exactly AWS for AWS Data Exports and nothing for fake; the synthetic providers are a separate, gated list', () => {
    expect(PROVIDER_MISMATCH).toBe('PROVIDER_MISMATCH');
    expect(SOURCE_TYPE_PROVIDERS).toEqual({ 'aws-data-exports': ['AWS'], fake: [] });
    expect(SYNTHETIC_PROVIDERS).toEqual(['SyntheticCloud', 'SyntheticAWS', 'SyntheticAzure', 'SyntheticGCP']);
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(SOURCE_TYPE_PROVIDERS)).toBe(true);
    for (const list of Object.values(SOURCE_TYPE_PROVIDERS)) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_PROVIDERS)).toBe(true);
    for (const opts of [OFF, ON]) {
      const p = awsPolicy(opts);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.allowed)).toBe(true);
    }
  });

  it('resolves the source type from the source row (kind + config.layout); synthetic providers only with the opt-in', () => {
    expect(providerPolicyFor(AWS_SOURCE, OFF)).toEqual({ sourceType: 'aws-data-exports', allowed: ['AWS'] });
    expect(providerPolicyFor(AWS_SOURCE, ON)).toEqual({ sourceType: 'aws-data-exports', allowed: ['AWS', 'SyntheticCloud', 'SyntheticAWS', 'SyntheticAzure', 'SyntheticGCP'] });
    expect(providerPolicyFor({ kind: 'fake', config: { fixture: 'synthetic-base' } }, OFF)).toEqual({ sourceType: 'fake', allowed: [] });
    expect(providerPolicyFor({ kind: 'fake', config: {} }, ON)).toEqual({ sourceType: 'fake', allowed: ['SyntheticCloud', 'SyntheticAWS', 'SyntheticAzure', 'SyntheticGCP'] });
  });

  it('only a literal true turns the opt-in on', () => {
    for (const v of [undefined, null, 1, '1', 'true', {}]) {
      expect(providerPolicyFor(AWS_SOURCE, { allowSyntheticProviders: v as unknown as boolean })?.allowed, String(v)).toEqual(['AWS']);
    }
  });

  it('resolves no type (no check) for a source the CLI cannot run: focus_file without the AWS layout, an unknown kind', () => {
    // DESIGN §8 D4; the source factory refuses these before any data is read (sourceFactory.test.ts).
    expect(providerPolicyFor({ kind: 'focus_file', config: {} }, ON)).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: { layout: 'AWS-DATA-EXPORTS' } }, ON)).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: { layout: 'azure-cost-exports' } }, ON)).toBeNull();
    expect(providerPolicyFor({ kind: 'other', config: { layout: 'aws-data-exports' } }, ON)).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: null }, ON)).toBeNull();
  });

  it('does not resolve a type from inherited properties of the config', () => {
    const inherited = Object.create({ layout: 'aws-data-exports' }) as Record<string, unknown>;
    expect(providerPolicyFor({ kind: 'focus_file', config: inherited }, ON)).toBeNull();
  });
});

describe('U1 checkProviderName', () => {
  it('accepts exactly the allowed values', () => {
    expect(checkProviderName('AWS', awsPolicy(OFF))).toEqual({ ok: true });
    expect(checkProviderName('AWS', awsPolicy(ON))).toEqual({ ok: true });
    expect(checkProviderName('SyntheticCloud', awsPolicy(ON))).toEqual({ ok: true });
  });

  it('opt-in OFF: SyntheticCloud under aws-data-exports is excluded as PROVIDER_MISMATCH', () => {
    expect(checkProviderName('SyntheticCloud', awsPolicy(OFF))).toEqual({
      ok: false,
      exclude: true,
      error: { column: 'ProviderName', code: 'PROVIDER_MISMATCH', message: 'ProviderName is not allowed for source type aws-data-exports (allowed: AWS); row excluded' },
    });
  });

  it('excludes a foreign provider with PROVIDER_MISMATCH on column ProviderName', () => {
    for (const [opts, allowed] of [
      [OFF, 'AWS'],
      [ON, 'AWS, SyntheticCloud, SyntheticAWS, SyntheticAzure, SyntheticGCP'],
    ] as const) {
      for (const foreign of ['Microsoft', 'Oracle', 'Google Cloud', 'Alibaba Cloud']) {
        const r = checkProviderName(foreign, awsPolicy(opts));
        expect(r.ok, foreign).toBe(false);
        if (r.ok) continue;
        expect(r.exclude, foreign).toBe(true);
        expect(r.error.code).toBe('PROVIDER_MISMATCH');
        expect(r.error.column).toBe('ProviderName');
        expect(r.error.message).toBe(`ProviderName is not allowed for source type aws-data-exports (allowed: ${allowed}); row excluded`);
      }
    }
  });

  it('is an exact match: case, whitespace, the long name and prefixes all mismatch', () => {
    const p = awsPolicy(ON);
    for (const near of ['aws', 'Aws', 'aWS', ' AWS', 'AWS ', 'AWS\t', 'A WS', 'AWSX', 'AW', 'AWS, Inc.', 'Amazon Web Services', 'Amazon Web Services, Inc.', 'amazon web services', 'ＡＷＳ', 'syntheticcloud', 'SyntheticCloud ', 'syntheticaws', 'SyntheticAWS ', 'SyntheticAws', 'Synthetic AWS', 'SyntheticOracle']) {
      const r = checkProviderName(near, p);
      expect(r.ok, JSON.stringify(near)).toBe(false);
      if (!r.ok) expect(r.error.code, JSON.stringify(near)).toBe('PROVIDER_MISMATCH');
    }
  });

  it('the fake type refuses AWS, and everything without the opt-in', () => {
    const on = providerPolicyFor({ kind: 'fake', config: {} }, ON)!;
    const r = checkProviderName('AWS', on);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exclude).toBe(true);
      expect(r.error.message).toBe('ProviderName is not allowed for source type fake (allowed: SyntheticCloud, SyntheticAWS, SyntheticAzure, SyntheticGCP); row excluded');
    }
    const off = checkProviderName('SyntheticCloud', providerPolicyFor({ kind: 'fake', config: {} }, OFF)!);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error.message).toBe('ProviderName is not allowed for source type fake (allowed: none); row excluded');
  });

  it('a NULL (empty) ProviderName is a hard MISSING_VALUE error, not an exclusion (fail closed: the whole batch is quarantined)', () => {
    for (const opts of [OFF, ON]) {
      expect(checkProviderName(null, awsPolicy(opts))).toEqual({
        ok: false,
        exclude: false,
        error: { column: 'ProviderName', code: 'MISSING_VALUE', message: 'required value is empty (FOCUS 1.0: ProviderName must not be null)' },
      });
    }
  });

  it('never puts the cell value into the error message', () => {
    const marker = 'Leaky-Provider-Value-7f3a';
    const r = checkProviderName(marker, awsPolicy(ON));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain(marker);
  });

  it('does not match inherited or prototype names', () => {
    const p = awsPolicy(ON);
    for (const v of ['constructor', '__proto__', 'toString', 'length', '0', 'includes']) {
      expect(checkProviderName(v, p).ok, v).toBe(false);
    }
  });
});

describe('U1 the fixed SYNTHETIC_PROVIDERS set under the opt-in (orchestrator, 2026-10-04)', () => {
  const SOURCES = [
    ['aws-data-exports', AWS_SOURCE],
    ['fake', { kind: 'fake', config: { fixture: 'synthetic-base' } }],
  ] as const;
  const SYNTHETIC = ['SyntheticCloud', 'SyntheticAWS', 'SyntheticAzure', 'SyntheticGCP'];

  it('opt-in OFF: none of them is accepted by any source type', () => {
    for (const [type, src] of SOURCES) {
      const p = providerPolicyFor(src, OFF)!;
      for (const name of SYNTHETIC) {
        const r = checkProviderName(name, p);
        expect(r.ok, `${type} ${name}`).toBe(false);
        if (!r.ok) expect(r.error.code, `${type} ${name}`).toBe('PROVIDER_MISMATCH');
      }
    }
  });

  it('opt-in ON: every one of them is accepted by every source type', () => {
    for (const [type, src] of SOURCES) {
      const p = providerPolicyFor(src, ON)!;
      for (const name of SYNTHETIC) expect(checkProviderName(name, p), `${type} ${name}`).toEqual({ ok: true });
    }
  });

  it('opt-in ON never widens real-provider acceptance: real names are checked against the per-type allowlist exactly as with it OFF', () => {
    const REAL = ['AWS', 'Amazon Web Services', 'Microsoft', 'Oracle', 'Google Cloud', 'Alibaba Cloud', 'aws', 'AWS ', 'Azure', 'GCP', 'Google', 'Cloud'];
    for (const [type, src] of SOURCES) {
      const on = providerPolicyFor(src, ON)!;
      const off = providerPolicyFor(src, OFF)!;
      for (const name of REAL) expect(checkProviderName(name, on).ok, `${type} ${name}`).toBe(checkProviderName(name, off).ok);
    }
    // Spelled out: AWS stays allowed for aws-data-exports only; fake still refuses it.
    expect(checkProviderName('AWS', providerPolicyFor(AWS_SOURCE, ON)!).ok).toBe(true);
    expect(checkProviderName('AWS', providerPolicyFor({ kind: 'fake', config: {} }, ON)!).ok).toBe(false);
    // The base lists stay real providers only.
    for (const list of Object.values(SOURCE_TYPE_PROVIDERS)) for (const name of SYNTHETIC) expect(list).not.toContain(name);
  });

  it('opt-in ON: the policy is exactly the per-type list followed by the synthetic set, and nothing else', () => {
    for (const [type, src] of SOURCES) {
      expect(providerPolicyFor(src, ON)!.allowed, type).toEqual([...SOURCE_TYPE_PROVIDERS[type], ...SYNTHETIC]);
      expect(providerPolicyFor(src, OFF)!.allowed, type).toEqual([...SOURCE_TYPE_PROVIDERS[type]]);
    }
  });
});

describe('U1 checkProviderHeader', () => {
  it('accepts a header with ProviderName', () => {
    expect(checkProviderHeader(headerIndex(FOCUS_HEADER), awsPolicy())).toBeNull();
  });
  it('refuses a header without ProviderName with MISSING_REQUIRED_COLUMN', () => {
    const cols = FOCUS_HEADER.filter((c) => c !== 'ProviderName');
    expect(checkProviderHeader(headerIndex(cols), awsPolicy())).toEqual({
      column: 'ProviderName',
      code: 'MISSING_REQUIRED_COLUMN',
      message: 'ProviderName is required for source type aws-data-exports (FOCUS 1.0 mandatory column)',
    });
  });
  it('is case-sensitive about the column name', () => {
    const cols = FOCUS_HEADER.map((c) => (c === 'ProviderName' ? 'providername' : c));
    expect(checkProviderHeader(headerIndex(cols), awsPolicy())?.code).toBe('MISSING_REQUIRED_COLUMN');
  });
});
