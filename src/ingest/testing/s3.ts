// Test-only S3 helpers for the real S3-compatible store (SeaweedFS locally).
// Tests that need S3 FAIL (never skip) when RATIO_TEST_S3_ENDPOINT is unset.
import crypto from 'crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

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

export function testS3Client(): S3Client {
  return new S3Client({
    endpoint: requireTestS3Endpoint(),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: TEST_S3_ACCESS_KEY_ID, secretAccessKey: TEST_S3_SECRET_ACCESS_KEY },
  });
}

/** Env for the worker CLI pointing both source and evidence at the test S3 endpoint. */
export function testS3Env(evidenceBucket: string): Record<string, string> {
  const endpoint = requireTestS3Endpoint();
  return {
    RATIO_SOURCE_S3_ENDPOINT: endpoint,
    RATIO_SOURCE_S3_REGION: 'us-east-1',
    RATIO_SOURCE_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY_ID,
    RATIO_SOURCE_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_ACCESS_KEY,
    RATIO_EVIDENCE_S3_ENDPOINT: endpoint,
    RATIO_EVIDENCE_S3_REGION: 'us-east-1',
    RATIO_EVIDENCE_S3_BUCKET: evidenceBucket,
    RATIO_EVIDENCE_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY_ID,
    RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_ACCESS_KEY,
  };
}

export interface TestBucket {
  name: string;
  client: S3Client;
  put(key: string, body: Buffer | string): Promise<void>;
  putAll(objects: Array<{ key: string; bytes: Buffer }>): Promise<void>;
  get(key: string): Promise<Buffer>;
  keys(prefix?: string): Promise<string[]>;
  /** Deletes every object and the bucket. */
  destroy(): Promise<void>;
}

export async function createTestBucket(label = 'b'): Promise<TestBucket> {
  const client = testS3Client();
  const name = `s1-${label}-${crypto.randomBytes(6).toString('hex')}`;
  await client.send(new CreateBucketCommand({ Bucket: name }));
  const keys = async (prefix = ''): Promise<string[]> => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, ContinuationToken: token }));
      for (const c of r.Contents ?? []) if (c.Key) out.push(c.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  };
  return {
    name,
    client,
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: name, Key: key, Body: typeof body === 'string' ? Buffer.from(body) : body }));
    },
    async putAll(objects) {
      for (const o of objects) await client.send(new PutObjectCommand({ Bucket: name, Key: o.key, Body: o.bytes }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: name, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    keys,
    async destroy() {
      for (const k of await keys()) await client.send(new DeleteObjectCommand({ Bucket: name, Key: k }));
      await client.send(new DeleteBucketCommand({ Bucket: name }));
      client.destroy();
    },
  };
}
