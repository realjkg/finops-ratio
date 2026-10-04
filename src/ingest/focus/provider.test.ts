// Issue #62 (U1): the per-source-type ProviderName allowlist and the
// PROVIDER_MISMATCH reason. Pure; no database. DESIGN: docs/evidence/issue-62/DESIGN.md.
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_MISMATCH,
  SOURCE_TYPE_PROVIDERS,
  SYNTHETIC_PROVIDER_NAME,
  checkProviderHeader,
  checkProviderName,
  providerPolicyFor,
  type ProviderPolicy,
} from './provider';
import { indexHeader } from './validate';
import { FOCUS_HEADER } from '../testing/focusCsv';

const AWS_SOURCE = { kind: 'focus_file', config: { layout: 'aws-data-exports', bucket: 'b', prefix: '', exportName: 'x' } };

function awsPolicy(): ProviderPolicy {
  const p = providerPolicyFor(AWS_SOURCE);
  if (!p) throw new Error('an aws-data-exports source must resolve a provider policy');
  return p;
}

function headerIndex(cols: readonly string[]) {
  const r = indexHeader([...cols]);
  if (!r.ok) throw new Error('header should be valid');
  return r.index;
}

describe('U1 the allowlist per source type', () => {
  it('is exactly AWS (+ the synthetic fixture provider) for AWS Data Exports, and the synthetic provider for fake', () => {
    expect(PROVIDER_MISMATCH).toBe('PROVIDER_MISMATCH');
    expect(SYNTHETIC_PROVIDER_NAME).toBe('SyntheticCloud');
    expect(SOURCE_TYPE_PROVIDERS).toEqual({ 'aws-data-exports': ['AWS', 'SyntheticCloud'], fake: ['SyntheticCloud'] });
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(SOURCE_TYPE_PROVIDERS)).toBe(true);
    for (const list of Object.values(SOURCE_TYPE_PROVIDERS)) expect(Object.isFrozen(list)).toBe(true);
    const p = awsPolicy();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.allowed)).toBe(true);
  });

  it('resolves the source type from the source row (kind + config.layout)', () => {
    expect(providerPolicyFor(AWS_SOURCE)).toEqual({ sourceType: 'aws-data-exports', allowed: ['AWS', 'SyntheticCloud'] });
    expect(providerPolicyFor({ kind: 'fake', config: { fixture: 'synthetic-base' } })).toEqual({ sourceType: 'fake', allowed: ['SyntheticCloud'] });
    expect(providerPolicyFor({ kind: 'fake', config: {} })).toEqual({ sourceType: 'fake', allowed: ['SyntheticCloud'] });
  });

  it('resolves no type (no check) for a source the CLI cannot run: focus_file without the AWS layout, an unknown kind', () => {
    // DESIGN §8 D4: the source factory refuses these before any data is read.
    expect(providerPolicyFor({ kind: 'focus_file', config: {} })).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: { layout: 'AWS-DATA-EXPORTS' } })).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: { layout: 'azure-cost-exports' } })).toBeNull();
    expect(providerPolicyFor({ kind: 'other', config: { layout: 'aws-data-exports' } })).toBeNull();
    expect(providerPolicyFor({ kind: 'focus_file', config: null as unknown as Record<string, unknown> })).toBeNull();
  });

  it('does not resolve a type from inherited properties of the config', () => {
    const inherited = Object.create({ layout: 'aws-data-exports' }) as Record<string, unknown>;
    expect(providerPolicyFor({ kind: 'focus_file', config: inherited })).toBeNull();
  });
});

describe('U1 checkProviderName', () => {
  it('accepts exactly the allowed values', () => {
    const p = awsPolicy();
    expect(checkProviderName('AWS', p)).toEqual({ ok: true });
    expect(checkProviderName('SyntheticCloud', p)).toEqual({ ok: true });
  });

  it('excludes a foreign provider with PROVIDER_MISMATCH on column ProviderName', () => {
    const p = awsPolicy();
    for (const foreign of ['Microsoft', 'Oracle', 'Google Cloud', 'Alibaba Cloud']) {
      const r = checkProviderName(foreign, p);
      expect(r.ok, foreign).toBe(false);
      if (r.ok) continue;
      expect(r.exclude, foreign).toBe(true);
      expect(r.error.code).toBe('PROVIDER_MISMATCH');
      expect(r.error.column).toBe('ProviderName');
      expect(r.error.message).toBe('ProviderName is not allowed for source type aws-data-exports (allowed: AWS, SyntheticCloud); row excluded');
    }
  });

  it('is an exact match: case, whitespace, the long name and prefixes all mismatch', () => {
    const p = awsPolicy();
    for (const near of ['aws', 'Aws', 'aWS', ' AWS', 'AWS ', 'AWS\t', 'A WS', 'AWSX', 'AW', 'AWS, Inc.', 'Amazon Web Services', 'Amazon Web Services, Inc.', 'amazon web services', 'ＡＷＳ', 'syntheticcloud', 'SyntheticCloud ']) {
      const r = checkProviderName(near, p);
      expect(r.ok, JSON.stringify(near)).toBe(false);
      if (!r.ok) expect(r.error.code, JSON.stringify(near)).toBe('PROVIDER_MISMATCH');
    }
  });

  it('the fake type refuses AWS', () => {
    const p = providerPolicyFor({ kind: 'fake', config: {} })!;
    const r = checkProviderName('AWS', p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exclude).toBe(true);
      expect(r.error.message).toBe('ProviderName is not allowed for source type fake (allowed: SyntheticCloud); row excluded');
    }
  });

  it('a NULL (empty) ProviderName is a hard MISSING_VALUE error, not an exclusion (fail closed: the whole batch is quarantined)', () => {
    const r = checkProviderName(null, awsPolicy());
    expect(r).toEqual({
      ok: false,
      exclude: false,
      error: { column: 'ProviderName', code: 'MISSING_VALUE', message: 'required value is empty (FOCUS 1.0: ProviderName must not be null)' },
    });
  });

  it('never puts the cell value into the error message', () => {
    const marker = 'Leaky-Provider-Value-7f3a';
    const r = checkProviderName(marker, awsPolicy());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain(marker);
  });

  it('does not match inherited or prototype names', () => {
    const p = awsPolicy();
    for (const v of ['constructor', '__proto__', 'toString', 'length', '0', 'includes']) {
      expect(checkProviderName(v, p).ok, v).toBe(false);
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
