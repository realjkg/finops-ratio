// S3 client construction from validated settings (endpoint/region/credentials
// from the environment only). Path-style when an endpoint is configured
// (SeaweedFS locally). Without static credentials the SDK default chain is used.
import { S3Client } from '@aws-sdk/client-s3';
import type { S3Settings } from './config';

export function makeS3Client(s: S3Settings): S3Client {
  return new S3Client({
    region: s.region,
    ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    forcePathStyle: s.forcePathStyle,
    ...(s.credentials ? { credentials: s.credentials } : {}),
    maxAttempts: 3,
    // Only send/validate flexible checksums when an operation requires them:
    // streamed uploads otherwise use aws-chunked trailers that some
    // S3-compatible stores (SeaweedFS) reject. Integrity is enforced by the
    // worker itself (sha256 at capture and again when parsing evidence).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
