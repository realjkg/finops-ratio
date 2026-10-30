// M1a: the per-source S3 client is built ONLY from the source's secret file (secretRef). Static key
// pair, or sts:AssumeRole with ExternalId; the SDK default credential chain, the region chain and
// configured endpoint URLs (AWS_* env) are never used. SYNTHETIC credentials and a local fake S3
// and STS only: no network to AWS.
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SignatureV4 } from '@smithy/signature-v4';
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SecretValue } from '../secrets/resolve';
import { assumeRole, parseAwsSecret, s3ClientFromSecret, signV4 } from './s3ClientFromSecret';
import { FakeS3 } from './testing/fakeS3';

const STATIC = { kind: 'static', accessKeyId: 'SYNTHETICKEYID0001', secretAccessKey: 'SYNTHETIC-secret-access-key-0001' };
const ROLE = {
  kind: 'assume-role', accessKeyId: 'SYNTHETICKEYID0002', secretAccessKey: 'SYNTHETIC-secret-access-key-0002',
  roleArn: 'arn:aws:iam::000000000000:role/ratio-focus-read', externalId: 'SYNTHETIC-external-id-1234',
};
/** Node's sha256 / HMAC-sha256 in the SDK's hash-constructor shape (test oracle only). */
class Sha256 {
  private readonly h: crypto.Hash | crypto.Hmac;
  constructor(key?: string | ArrayBuffer | ArrayBufferView) {
    this.h = key === undefined ? crypto.createHash('sha256') : crypto.createHmac('sha256', bytes(key));
  }
  update(d: string | ArrayBuffer | ArrayBufferView): void {
    this.h.update(bytes(d));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
}
function bytes(d: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof d === 'string') return Buffer.from(d, 'utf8');
  return ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(d);
}
const secret = (v: unknown) => new SecretValue('aws/focus', typeof v === 'string' ? v : JSON.stringify(v));
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message };
  }
  return { code: undefined, message: '' };
};

describe('parseAwsSecret', () => {
  it('refuses a missing, malformed or unknown-key secret, naming the key and never echoing a value', () => {
    expect(codeOf(() => parseAwsSecret(undefined)).code).toBe('SECRET_INVALID');
    expect(codeOf(() => parseAwsSecret(secret('AKIA-not-json'))).code).toBe('SECRET_INVALID');
    expect(codeOf(() => parseAwsSecret(secret({ ...STATIC, kind: 'profile' }))).code).toBe('SECRET_INVALID');
    const unknown = codeOf(() => parseAwsSecret(secret({ ...STATIC, region: 'us-east-1' })));
    expect(unknown).toMatchObject({ code: 'SECRET_INVALID' });
    expect(unknown.message).toContain('region');
    const missing = codeOf(() => parseAwsSecret(secret({ kind: 'static', accessKeyId: STATIC.accessKeyId })));
    expect(missing.message).toContain('secretAccessKey');
    expect(missing.message).not.toContain(STATIC.accessKeyId);
    const badArn = codeOf(() => parseAwsSecret(secret({ ...ROLE, roleArn: 'not-an-arn-SYNTHETIC' })));
    expect(badArn.message).toContain('roleArn');
    expect(badArn.message).not.toContain('not-an-arn-SYNTHETIC');
    expect(codeOf(() => parseAwsSecret(secret({ ...ROLE, externalId: undefined }))).message).toContain('externalId');
    expect(codeOf(() => parseAwsSecret(secret({ ...ROLE, durationSeconds: 60 }))).message).toContain('durationSeconds');
  });

  it('accepts a static key pair and an assume-role secret', () => {
    expect(parseAwsSecret(secret(STATIC))).toMatchObject({ kind: 'static', accessKeyId: STATIC.accessKeyId });
    expect(parseAwsSecret(secret(ROLE))).toMatchObject({ kind: 'assume-role', roleArn: ROLE.roleArn, externalId: ROLE.externalId, durationSeconds: 3600, sessionName: 'ratio-focus-retrieval' });
  });
});

describe('signV4', () => {
  // The worked example of the AWS SigV4 documentation (IAM ListUsers, 2015-08-30), with its published signature.
  it('reproduces the documented example signature', () => {
    const h = signV4({
      method: 'GET', host: 'iam.amazonaws.com', path: '/', query: 'Action=ListUsers&Version=2010-05-08', body: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, region: 'us-east-1', service: 'iam',
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('agrees with the AWS SDK signer on an STS POST with a session token', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const creds = { accessKeyId: 'SYNTHETICKEYID0003', secretAccessKey: 'SYNTHETIC-secret-3', sessionToken: 'SYNTHETIC-session-token-3' };
    const body = 'Action=AssumeRole&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A000000000000%3Arole%2Fx';
    const mine = signV4({ method: 'POST', host: 'sts.eu-west-1.amazonaws.com', path: '/', body, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, region: 'eu-west-1', service: 'sts', creds, now });
    const sdk = await new SignatureV4({ credentials: creds, region: 'eu-west-1', service: 'sts', sha256: Sha256, applyChecksum: false }).sign(
      { method: 'POST', protocol: 'https:', hostname: 'sts.eu-west-1.amazonaws.com', path: '/', headers: { host: 'sts.eu-west-1.amazonaws.com', 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body },
      { signingDate: now },
    );
    expect(mine.authorization).toBe(sdk.headers.authorization);
  });
});

describe('s3ClientFromSecret', () => {
  const s3 = new FakeS3('synthetic-export-bucket');
  const saved = { ...process.env };
  beforeAll(async () => {
    await s3.start();
  });
  afterAll(async () => {
    await s3.stop();
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    s3.requests.length = 0;
  });

  it('a static secret is the only credential, region and endpoint source: AWS_* env and configured endpoint URLs are ignored', async () => {
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: 'AKIAENVIRONMENTKEY01', AWS_SECRET_ACCESS_KEY: 'env-secret-SYNTHETIC', AWS_SESSION_TOKEN: 'env-token-SYNTHETIC',
      AWS_REGION: 'ap-southeast-2', AWS_DEFAULT_REGION: 'ap-southeast-2', AWS_PROFILE: 'synthetic-profile', AWS_ENDPOINT_URL: 'http://127.0.0.1:9', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9',
    });
    const registered: string[] = [];
    const { client, kind } = s3ClientFromSecret({ secret: secret(STATIC), region: 'us-east-1', endpoint: s3.endpoint, registerSecret: (v) => registered.push(v) });
    expect(kind).toBe('static');
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: STATIC.accessKeyId, secretAccessKey: STATIC.secretAccessKey });
    expect(await client.config.region()).toBe('us-east-1');
    await client.send(new ListObjectsV2Command({ Bucket: 'synthetic-export-bucket', Prefix: 'x/' }));
    expect(s3.requests).toHaveLength(1);
    expect(String(s3.requests[0].headers.authorization)).toContain(`Credential=${STATIC.accessKeyId}/`);
    expect(String(s3.requests[0].headers.authorization)).toContain('/us-east-1/s3/aws4_request');
    expect(s3.requests[0].headers['x-amz-security-token']).toBeUndefined();
    expect(registered).toEqual(expect.arrayContaining([STATIC.secretAccessKey]));
    client.destroy();
  });

  it('without params.endpoint, AWS_ENDPOINT_URL(_S3) is ignored: the request is addressed to the regional AWS endpoint (stopped before sending)', async () => {
    Object.assign(process.env, { AWS_ENDPOINT_URL: s3.endpoint, AWS_ENDPOINT_URL_S3: s3.endpoint });
    const { client } = s3ClientFromSecret({ secret: secret(STATIC), region: 'eu-west-1', registerSecret: () => undefined });
    let host = '';
    client.middlewareStack.add(
      () => async (args) => {
        host = (args.request as { hostname: string }).hostname;
        throw new Error('stopped before sending');
      },
      { step: 'finalizeRequest' },
    );
    await expect(client.send(new ListObjectsV2Command({ Bucket: 'synthetic-export-bucket' }))).rejects.toThrow('stopped before sending');
    expect(host).toBe('synthetic-export-bucket.s3.eu-west-1.amazonaws.com');
    expect(s3.requests).toHaveLength(0);
    client.destroy();
  });

  it('assume-role: signs sts:AssumeRole with the secret key pair and ExternalId, uses only the returned session, caches it until near expiry', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAENVIRONMENTKEY01';
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let now = new Date('2026-10-30T10:00:00Z');
    const fetchFake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: init.body, headers: init.headers });
      const n = calls.length;
      return new Response(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIASYNTHETIC0000${n}</AccessKeyId><SecretAccessKey>SYNTHETIC-session-secret-${n}</SecretAccessKey><SessionToken>SYNTHETIC-session-token-${n}</SessionToken><Expiration>2026-10-30T11:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const registered: string[] = [];
    const { client, kind, credentials } = s3ClientFromSecret({ secret: secret(ROLE), region: 'eu-west-1', endpoint: s3.endpoint, registerSecret: (v) => registered.push(v), fetch: fetchFake, now: () => now });
    expect(kind).toBe('assume-role');
    await client.send(new ListObjectsV2Command({ Bucket: 'synthetic-export-bucket', Prefix: 'x/' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sts.eu-west-1.amazonaws.com/');
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: ROLE.roleArn, RoleSessionName: 'ratio-focus-retrieval', ExternalId: ROLE.externalId, DurationSeconds: '3600' });
    expect(calls[0].headers.authorization).toContain(`Credential=${ROLE.accessKeyId}/20261030/eu-west-1/sts/aws4_request`);
    const auth = String(s3.requests[0].headers.authorization);
    expect(auth).toContain('Credential=ASIASYNTHETIC00001/');
    expect(s3.requests[0].headers['x-amz-security-token']).toBe('SYNTHETIC-session-token-1');
    expect(registered).toEqual(expect.arrayContaining(['SYNTHETIC-session-secret-1', 'SYNTHETIC-session-token-1']));
    // The provider's own cache (the SDK adds its own on top, on the real clock).
    now = new Date('2026-10-30T10:30:00Z');
    expect(await credentials()).toMatchObject({ accessKeyId: 'ASIASYNTHETIC00001' });
    expect(calls).toHaveLength(1);
    now = new Date('2026-10-30T10:56:00Z'); // within 5 minutes of expiry: refreshed
    expect(await credentials()).toMatchObject({ accessKeyId: 'ASIASYNTHETIC00002', sessionToken: 'SYNTHETIC-session-token-2' });
    expect(calls).toHaveLength(2);
    client.destroy();
  });

  it('a refused or unreachable AssumeRole fails with a code and never echoes the response body or the secret', async () => {
    const refused = (async () => new Response('<ErrorResponse><Error><Code>AccessDenied</Code><Message>SYNTHETIC-leak-marker</Message></Error></ErrorResponse>', { status: 403 })) as unknown as typeof fetch;
    const p = parseAwsSecret(secret(ROLE));
    if (p.kind !== 'assume-role') throw new Error('expected assume-role');
    const e1 = await assumeRole(p, 'us-east-1', { fetch: refused }).catch((e) => e);
    expect(e1).toMatchObject({ code: 'AUTH_FAILED' });
    expect(e1.message).toContain('AccessDenied');
    expect(e1.message).not.toContain('SYNTHETIC-leak-marker');
    expect(e1.message).not.toContain(ROLE.secretAccessKey);
    const down = (async () => {
      throw new Error(`connect failed ${ROLE.secretAccessKey}`);
    }) as unknown as typeof fetch;
    const e2 = await assumeRole(p, 'us-east-1', { fetch: down }).catch((e) => e);
    expect(e2).toMatchObject({ code: 'AUTH_UNREACHABLE' });
    expect(e2.message).not.toContain(ROLE.secretAccessKey);
    const garbled = (async () => new Response('<AssumeRoleResponse/>', { status: 200 })) as unknown as typeof fetch;
    expect(await assumeRole(p, 'us-east-1', { fetch: garbled }).catch((e) => e)).toMatchObject({ code: 'AUTH_FAILED' });
  });
});
