// SigV4 signer — verified against the worked examples in the AWS S3 docs
// ("Signature Calculations for the Authorization Header: Transferring Payload
// in a Single Chunk", GET Object and GET Bucket (List Objects) examples).

import { describe, it, expect } from 'vitest';
import { signS3Request } from './sigv4';

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const NOW = new Date('2013-05-24T00:00:00Z');

function signatureOf(auth: string): string {
  return auth.split('Signature=')[1];
}

describe('signS3Request', () => {
  it('matches the AWS GET Object example (signed Range header)', async () => {
    const headers = await signS3Request(
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        region: 'us-east-1',
        headers: { Range: 'bytes=0-9' },
        now: NOW,
      },
      CREDS,
    );
    expect(headers.Authorization).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(headers.Authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(signatureOf(headers.Authorization)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the AWS GET Bucket (List Objects) example (sorted query)', async () => {
    const headers = await signS3Request(
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
        region: 'us-east-1',
        now: NOW,
      },
      CREDS,
    );
    expect(signatureOf(headers.Authorization)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('signs and sends the session token for temporary credentials', async () => {
    const headers = await signS3Request(
      { method: 'GET', url: 'https://b.s3.us-east-1.amazonaws.com/', region: 'us-east-1', now: NOW },
      { ...CREDS, sessionToken: 'FQoGZXIvYXdzEXAMPLE' },
    );
    expect(headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLE');
    expect(headers.Authorization).toContain('x-amz-security-token');
    expect(headers).not.toHaveProperty('host');
  });
});
