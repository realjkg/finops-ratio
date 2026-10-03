import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config';
import { assertFakeSourceAllowed } from './sources/fake/FakeFocusSource';

const base = { RATIO_DATABASE_URL: 'postgres://w@127.0.0.1:1/db' };

describe('loadWorkerConfig', () => {
  it('applies safe defaults', () => {
    const c = loadWorkerConfig(base);
    expect(c.env).toBe('development');
    expect(c.settings.leaseTtlSeconds).toBe(300);
    expect(c.settings.maxAttempts).toBe(3);
    expect(c.settings.limits.insertChunkRows).toBe(1000);
    expect(c.settings.limits.maxRowsPerBatch).toBe(20_000_000);
    expect(c.testPauseAfterRows).toBeNull();
    expect(c.allowFakeSource).toBe(false);
    expect(c.artifactDigest).toBeNull();
    expect(c.sourceS3.region).toBe('us-east-1');
  });

  it('refuses out-of-range or non-integer numbers', () => {
    for (const [k, v] of [
      ['RATIO_LEASE_TTL_SECONDS', '4'],
      ['RATIO_LEASE_TTL_SECONDS', '3601'],
      ['RATIO_MAX_ATTEMPTS', '0'],
      ['RATIO_MAX_ATTEMPTS', '11'],
      ['RATIO_INSERT_CHUNK_ROWS', '5001'],
      ['RATIO_INSERT_CHUNK_ROWS', '1.5'],
      ['RATIO_MAX_ROWS_PER_BATCH', '-1'],
      ['RATIO_MAX_ARTIFACT_BYTES', 'lots'],
      ['RATIO_DOCTOR_MAX_STALENESS_HOURS', '0'],
    ]) {
      expect(() => loadWorkerConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('refuses an unknown RATIO_ENV', () => {
    expect(() => loadWorkerConfig({ ...base, RATIO_ENV: 'prod' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('the test kill hook is impossible to enable outside NODE_ENV=test', () => {
    expect(loadWorkerConfig({ ...base, NODE_ENV: 'test', RATIO_TEST_PAUSE_AFTER_ROWS: '20' }).testPauseAfterRows).toBe(20);
    for (const nodeEnv of [undefined, 'production', 'development', 'TEST', 'test ']) {
      expect(() => loadWorkerConfig({ ...base, NODE_ENV: nodeEnv, RATIO_TEST_PAUSE_AFTER_ROWS: '20' }), String(nodeEnv)).toThrow(
        expect.objectContaining({ code: 'TEST_HOOK_NOT_ALLOWED' }),
      );
    }
  });

  it('fake source is allowed only with RATIO_ALLOW_FAKE_SOURCE=1 AND NODE_ENV=test', () => {
    expect(loadWorkerConfig({ ...base, NODE_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: '1' }).allowFakeSource).toBe(true);
    expect(loadWorkerConfig({ ...base, NODE_ENV: 'test' }).allowFakeSource).toBe(false);
    expect(loadWorkerConfig({ ...base, RATIO_ALLOW_FAKE_SOURCE: '1' }).allowFakeSource).toBe(false);
    expect(loadWorkerConfig({ ...base, NODE_ENV: 'production', RATIO_ALLOW_FAKE_SOURCE: '1' }).allowFakeSource).toBe(false);
    expect(() => assertFakeSourceAllowed({ NODE_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: '1' })).not.toThrow();
    for (const env of [{}, { NODE_ENV: 'test' }, { RATIO_ALLOW_FAKE_SOURCE: '1' }, { NODE_ENV: 'production', RATIO_ALLOW_FAKE_SOURCE: '1' }, { NODE_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: 'true' }]) {
      expect(() => assertFakeSourceAllowed(env), JSON.stringify(env)).toThrow(expect.objectContaining({ code: 'FAKE_SOURCE_NOT_ALLOWED' }));
    }
  });

  it('refuses S3 endpoints carrying credentials, query or fragment', () => {
    for (const ep of ['http://user:pw@127.0.0.1:9000', 'http://127.0.0.1:9000/?X-Amz-Signature=x', 'http://h#frag', 'ftp://h', 'not a url']) {
      expect(() => loadWorkerConfig({ ...base, RATIO_SOURCE_S3_ENDPOINT: ep }), ep).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => loadWorkerConfig({ ...base, RATIO_EVIDENCE_S3_ENDPOINT: ep }), ep).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('refuses plain-http S3 endpoints in production, allows them elsewhere', () => {
    expect(() => loadWorkerConfig({ ...base, RATIO_ENV: 'production', RATIO_SOURCE_S3_ENDPOINT: 'http://s3.local:8333' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(loadWorkerConfig({ ...base, RATIO_ENV: 'staging', RATIO_SOURCE_S3_ENDPOINT: 'http://s3.local:8333' }).sourceS3.endpoint).toBe(
      'http://s3.local:8333',
    );
    expect(loadWorkerConfig({ ...base, RATIO_ENV: 'production', RATIO_SOURCE_S3_ENDPOINT: 'https://s3.example.test' }).sourceS3.forcePathStyle).toBe(true);
  });

  it('requires both halves of a static S3 credential pair', () => {
    expect(() => loadWorkerConfig({ ...base, RATIO_SOURCE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    const c = loadWorkerConfig({ ...base, RATIO_EVIDENCE_S3_ACCESS_KEY_ID: 'a', RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY: 'b', RATIO_EVIDENCE_S3_BUCKET: 'ev-bucket' });
    expect(c.evidenceS3.credentials).toEqual({ accessKeyId: 'a', secretAccessKey: 'b' });
    expect(c.evidenceS3.bucket).toBe('ev-bucket');
  });

  it('enforces RATIO_ARTIFACT_DIGEST format', () => {
    const d = 'sha256:' + 'a'.repeat(64);
    expect(loadWorkerConfig({ ...base, RATIO_ARTIFACT_DIGEST: d }).artifactDigest).toBe(d);
    expect(() => loadWorkerConfig({ ...base, RATIO_ARTIFACT_DIGEST: 'latest' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('config errors never echo secret values', () => {
    try {
      loadWorkerConfig({ ...base, RATIO_SOURCE_S3_ENDPOINT: 'http://user:topsecretpw@h' });
      throw new Error('expected failure');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('topsecretpw');
    }
  });

  it('stall watchdog and maximum run duration have defaults and bounds (M-1)', () => {
    const c = loadWorkerConfig(base);
    expect(c.settings.stallTimeoutSeconds).toBe(120);
    expect(c.settings.maxRunSeconds).toBe(6 * 3600);
    expect(loadWorkerConfig({ ...base, RATIO_STALL_TIMEOUT_SECONDS: '30', RATIO_MAX_RUN_SECONDS: '600' }).settings).toMatchObject({ stallTimeoutSeconds: 30, maxRunSeconds: 600 });
    for (const [k, v] of [
      ['RATIO_STALL_TIMEOUT_SECONDS', '0'],
      ['RATIO_STALL_TIMEOUT_SECONDS', '3601'],
      ['RATIO_MAX_RUN_SECONDS', '59'],
    ]) {
      expect(() => loadWorkerConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('L3: test-only switches refuse to activate when RATIO_ENV is staging or production, even with NODE_ENV=test', () => {
    for (const ratioEnv of ['staging', 'production']) {
      expect(() => loadWorkerConfig({ ...base, NODE_ENV: 'test', RATIO_ENV: ratioEnv, RATIO_TEST_PAUSE_AFTER_ROWS: '5' }), ratioEnv).toThrow(
        expect.objectContaining({ code: 'TEST_HOOK_NOT_ALLOWED' }),
      );
      expect(loadWorkerConfig({ ...base, NODE_ENV: 'test', RATIO_ENV: ratioEnv, RATIO_ALLOW_FAKE_SOURCE: '1' }).allowFakeSource, ratioEnv).toBe(false);
      expect(() => assertFakeSourceAllowed({ NODE_ENV: 'test', RATIO_ENV: ratioEnv, RATIO_ALLOW_FAKE_SOURCE: '1' }), ratioEnv).toThrow(
        expect.objectContaining({ code: 'FAKE_SOURCE_NOT_ALLOWED' }),
      );
    }
    expect(loadWorkerConfig({ ...base, NODE_ENV: 'test', RATIO_ENV: 'test', RATIO_TEST_PAUSE_AFTER_ROWS: '5' }).testPauseAfterRows).toBe(5);
    expect(() => assertFakeSourceAllowed({ NODE_ENV: 'test', RATIO_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: '1' })).not.toThrow();
  });

  it('L-b: worker DB session timeouts have defaults and bounds', () => {
    const c = loadWorkerConfig(base);
    expect(c.db).toEqual({ lockTimeoutMs: 30_000, idleInTransactionTimeoutMs: 300_000, statementTimeoutMs: 1_800_000 });
    expect(loadWorkerConfig({ ...base, RATIO_DB_LOCK_TIMEOUT_MS: '5000' }).db.lockTimeoutMs).toBe(5000);
    for (const [k, v] of [
      ['RATIO_DB_LOCK_TIMEOUT_MS', '0'],
      ['RATIO_DB_IDLE_IN_TX_TIMEOUT_MS', '999'],
      ['RATIO_DB_STATEMENT_TIMEOUT_MS', '0'],
    ]) {
      expect(() => loadWorkerConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });
});
