// Test-only S3 helpers for the real S3-compatible store (SeaweedFS locally).
// Tests that need S3 FAIL (never skip) when RATIO_TEST_S3_ENDPOINT is unset.
//
// The local SeaweedFS (`server -s3`, default config) has a small number of
// volume slots (derived from free disk) and grows 7 per bucket on first write;
// a deleted bucket's volumes are not reclaimed immediately, so creating a new
// bucket per run fails with `InternalError` (500) when runs follow each other
// closely. The DB suite therefore uses ONE long-lived bucket (TEST_S3_BUCKET,
// created once, never deleted); each run gets a unique key prefix
// (s3GlobalSetup.ts) and every test works under its own unique key prefix
// (`root`) inside that, deleted afterwards.
import crypto from 'crypto';
import { inject } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

declare module 'vitest' {
  export interface ProvidedContext {
    ratioTestS3Bucket: string;
    ratioTestS3RunPrefix: string;
  }
}

export function requireTestS3Endpoint(env: Record<string, string | undefined> = process.env): string {
  const url = env.RATIO_TEST_S3_ENDPOINT;
  if (!url || url.trim() === '') {
    throw new Error(
      'RATIO_TEST_S3_ENDPOINT is not set. S3 integration tests need an S3-compatible endpoint ' +
        '(e.g. http://127.0.0.1:18333 for the local SeaweedFS container); refusing to run (tests are never skipped).',
    );
  }
  return url;
}

/** Throwaway credentials: the local SeaweedFS default config accepts any key pair. */
export const TEST_S3_ACCESS_KEY_ID = 'ratio-test-access';
export const TEST_S3_SECRET_ACCESS_KEY = 'ratio-test-secret-value';

/** The one long-lived bucket the DB suite works in (objects are per-run, per-scope prefixes). */
export const TEST_S3_BUCKET = 'ratio-s1-test';

export function testS3Client(endpoint: string = requireTestS3Endpoint()): S3Client {
  return new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: TEST_S3_ACCESS_KEY_ID, secretAccessKey: TEST_S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function sharedBucket(): string {
  requireTestS3Endpoint();
  const name = inject('ratioTestS3Bucket');
  if (!name) throw new Error('the shared test bucket was not created (s3GlobalSetup did not run with RATIO_TEST_S3_ENDPOINT)');
  return name;
}

/**
 * Env for the worker CLI: source and evidence on the test endpoint; evidence under the scope's root.
 * Also the synthetic-provider opt-in (issue #62 D1): the CLI tests ingest the SYNTHETIC fixture
 * (ProviderName SyntheticCloud); a test that needs it off overrides it with '0'.
 * Opt-in placement confirmed by the orchestrator, 2026-10-04.
 */
export function testS3Env(evidence: TestBucket): Record<string, string> {
  const endpoint = requireTestS3Endpoint();
  return {
    RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1',
    // The opt-in needs RATIO_ENV explicitly development or test (challenger L3); the worker
    // treats an unset RATIO_ENV as development, so this changes nothing else. Overridable.
    RATIO_ENV: 'development',
    RATIO_SOURCE_S3_ENDPOINT: endpoint,
    RATIO_SOURCE_S3_REGION: 'us-east-1',
    RATIO_SOURCE_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY_ID,
    RATIO_SOURCE_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_ACCESS_KEY,
    RATIO_EVIDENCE_S3_ENDPOINT: endpoint,
    RATIO_EVIDENCE_S3_REGION: 'us-east-1',
    RATIO_EVIDENCE_S3_BUCKET: evidence.name,
    RATIO_EVIDENCE_S3_PREFIX: evidence.root,
    RATIO_EVIDENCE_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY_ID,
    RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_ACCESS_KEY,
  };
}

/** A unique key-prefix scope in the shared test bucket. All keys are ABSOLUTE bucket keys. */
export interface TestBucket {
  name: string;
  /** Unique prefix owned by this scope (no trailing slash). */
  root: string;
  client: S3Client;
  /** `${root}/${rel}` */
  at(rel: string): string;
  put(key: string, body: Buffer | string): Promise<void>;
  putAll(objects: Array<{ key: string; bytes: Buffer }>): Promise<void>;
  /** Uploads objects whose keys are relative to root. */
  putUnderRoot(objects: Array<{ key: string; bytes: Buffer }>): Promise<void>;
  get(key: string): Promise<Buffer>;
  keys(prefix?: string): Promise<string[]>;
  /** Deletes every object under `root`. */
  destroy(): Promise<void>;
}

export async function listKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const c of r.Contents ?? []) if (c.Key) out.push(c.Key);
    if (r.IsTruncated && !r.NextContinuationToken) throw new Error(`listing ${prefix} claims more results but has no continuation token`);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort();
}

export async function createTestBucket(label = 'b'): Promise<TestBucket> {
  const name = sharedBucket();
  const client = testS3Client();
  const runPrefix = inject('ratioTestS3RunPrefix');
  if (!runPrefix) throw new Error('the test run prefix was not provided (s3GlobalSetup did not run with RATIO_TEST_S3_ENDPOINT)');
  const root = `${runPrefix}/s1-${label}-${crypto.randomBytes(6).toString('hex')}`;
  const put = async (key: string, body: Buffer | string) => {
    await client.send(new PutObjectCommand({ Bucket: name, Key: key, Body: typeof body === 'string' ? Buffer.from(body) : body }));
  };
  return {
    name,
    root,
    client,
    at: (rel) => `${root}/${rel}`,
    put,
    async putAll(objects) {
      for (const o of objects) await put(o.key, o.bytes);
    },
    async putUnderRoot(objects) {
      for (const o of objects) await put(`${root}/${o.key}`, o.bytes);
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: name, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    keys: (prefix = `${root}/`) => listKeys(client, name, prefix),
    async destroy() {
      for (const k of await listKeys(client, name, `${root}/`)) await client.send(new DeleteObjectCommand({ Bucket: name, Key: k }));
      client.destroy();
    },
  };
}
