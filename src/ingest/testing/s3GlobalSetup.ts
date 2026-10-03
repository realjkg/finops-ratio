// Vitest globalSetup for the DB suite: when RATIO_TEST_S3_ENDPOINT is set,
// ensures the ONE long-lived test bucket exists (see testing/s3.ts for why it
// is never deleted) and gives this run a unique key prefix inside it; at the
// end every object under that prefix is deleted. When the endpoint is unset
// nothing is created and every S3 test fails in requireTestS3Endpoint (never
// skipped).
import crypto from 'crypto';
import { CreateBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { TestProject } from 'vitest/node';
import { listKeys, TEST_S3_BUCKET, testS3Client } from './s3';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const endpoint = process.env.RATIO_TEST_S3_ENDPOINT;
  if (!endpoint || endpoint.trim() === '') {
    project.provide('ratioTestS3Bucket', '');
    project.provide('ratioTestS3RunPrefix', '');
    return async () => undefined;
  }
  const client = testS3Client(endpoint);
  try {
    await client.send(new CreateBucketCommand({ Bucket: TEST_S3_BUCKET }));
  } catch (e) {
    const name = (e as { name?: string })?.name;
    // Created by an earlier (or a concurrent) run: that is the point.
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  }
  const runPrefix = `s1-run-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  project.provide('ratioTestS3Bucket', TEST_S3_BUCKET);
  project.provide('ratioTestS3RunPrefix', runPrefix);
  return async () => {
    for (const k of await listKeys(client, TEST_S3_BUCKET, `${runPrefix}/`)) await client.send(new DeleteObjectCommand({ Bucket: TEST_S3_BUCKET, Key: k }));
    client.destroy();
  };
}
