import { expect, it } from 'vitest';
import { parseS3Listing } from './awsS3Transport';
it('rejects a truncated S3 listing with a missing or empty continuation token (#57)', () => {
  for (const token of ['', '<NextContinuationToken></NextContinuationToken>']) {
    expect(() => parseS3Listing(`<ListBucketResult><IsTruncated>true</IsTruncated>${token}</ListBucketResult>`)).toThrow(/continuation/i);
  }
  expect(parseS3Listing('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>').continuationToken).toBe('next');
});
