import { describe, expect, it } from 'vitest';
import { buildEvidenceRecord, resolveGitSha } from './evidenceRecord';

describe('evidence record', () => {
  it('has the machine-readable shape the pipeline consumes', () => {
    const started = new Date('2026-10-01T00:00:00.000Z');
    const finished = new Date('2026-10-01T00:00:02.500Z');
    const rec = buildEvidenceRecord({
      command: 'sync',
      args: { tenant: '11111111-1111-4111-8111-111111111111', source: 'focus-main' },
      gitSha: 'a'.repeat(40),
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      startedAt: started,
      finishedAt: finished,
      results: { periods: [] },
      pass: true,
      exitCode: 0,
    });
    expect(rec).toEqual({
      type: 'ratio.evidence',
      version: 1,
      command: 'sync',
      args: { tenant: '11111111-1111-4111-8111-111111111111', source: 'focus-main' },
      gitSha: 'a'.repeat(40),
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:02.500Z',
      durationMs: 2500,
      results: { periods: [] },
      pass: true,
      exitCode: 0,
    });
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });

  it('redacts secrets that reach results', () => {
    const rec = buildEvidenceRecord({
      command: 'sync',
      args: {},
      gitSha: null,
      artifactDigest: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      results: { error: 'failed GET https://h/x?X-Amz-Signature=abcdef123 with Bearer tok.en.value' },
      pass: false,
      exitCode: 1,
      secrets: ['literal-secret-xyz'],
    });
    const text = JSON.stringify(rec);
    expect(text).not.toContain('abcdef123');
    expect(text).not.toContain('tok.en.value');
    expect(JSON.stringify(buildEvidenceRecord({ ...rec, startedAt: new Date(), finishedAt: new Date(), results: { e: 'x literal-secret-xyz' }, secrets: ['literal-secret-xyz'] }))).not.toContain('literal-secret-xyz');
  });

  it('git SHA precedence: env, then build-info, then null; invalid env values ignored', () => {
    expect(resolveGitSha({ RATIO_GIT_SHA: 'c'.repeat(40) }, { buildInfoSha: 'd'.repeat(40), gitLookup: () => 'e'.repeat(40) })).toBe('c'.repeat(40));
    expect(resolveGitSha({}, { buildInfoSha: 'd'.repeat(40), gitLookup: () => 'e'.repeat(40) })).toBe('d'.repeat(40));
    expect(resolveGitSha({}, { buildInfoSha: null, gitLookup: () => 'e'.repeat(40) })).toBe('e'.repeat(40));
    expect(resolveGitSha({}, { buildInfoSha: null, gitLookup: () => null })).toBeNull();
    expect(resolveGitSha({ RATIO_GIT_SHA: 'not-a-sha; rm -rf /' }, { buildInfoSha: null, gitLookup: () => null })).toBeNull();
  });
});
