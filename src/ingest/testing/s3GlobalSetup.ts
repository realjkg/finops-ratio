// Vitest globalSetup for the DB suite: when RATIO_TEST_S3_ENDPOINT is set,
// creates ONE uniquely named bucket for the whole run (see testing/s3.ts for
// why) and deletes it, with every object, at the end. When it is unset nothing
// is created and every S3 test fails in requireTestS3Endpoint (never skipped).
import crypto from 'crypto';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { TestProject } from 'vitest/node';
import { listKeys, testS3Client } from './s3';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const endpoint = process.env.RATIO_TEST_S3_ENDPOINT;
  if (!endpoint || endpoint.trim() === '') {
    project.provide('ratioTestS3Bucket', '');
    return async () => undefined;
  }
  const client = testS3Client(endpoint);
  const bucket = `s1-run-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  project.provide('ratioTestS3Bucket', bucket);
  return async () => {
    for (const k of await listKeys(client, bucket, '')) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  };
}
