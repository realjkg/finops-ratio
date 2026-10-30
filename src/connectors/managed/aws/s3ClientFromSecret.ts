// M1a: the S3 client of ONE managed AWS source, built only from its secret file (secretRef in
// RATIO_SECRETS_DIR): a static key pair, or sts:AssumeRole with ExternalId signed with the key pair
// in the same file. The SDK default credential chain, region chain, profiles and configured
// endpoint URLs (AWS_* env, ~/.aws files) are never consulted. Errors name keys, never values;
// every derived session credential is registered for scrubbing.
import crypto from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { ManagedError } from '../engagementSpec';
import type { SecretValue } from '../secrets/resolve';

export interface AwsCreds { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }
export type AwsSecret =
  | { kind: 'static'; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: 'assume-role'; accessKeyId: string; secretAccessKey: string; roleArn: string; externalId: string; sessionName: string; durationSeconds: number };

const KEYS = { static: ['kind', 'accessKeyId', 'secretAccessKey', 'sessionToken'], 'assume-role': ['kind', 'accessKeyId', 'secretAccessKey', 'roleArn', 'externalId', 'sessionName', 'durationSeconds'] };
const LINE_RE = /^[\x21-\x7e]{1,2048}$/;
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const EXTERNAL_ID_RE = /^[\w+=,.@:/-]{2,1224}$/;
const SESSION_RE = /^[\w+=,.@-]{2,64}$/;
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();

export function parseAwsSecret(secret: SecretValue | undefined): AwsSecret {
  const bad = (m: string): never => {
    throw new ManagedError('SECRET_INVALID', `AWS secret ${secret?.ref ?? '(none)'}: ${m}`);
  };
  if (!secret) return bad('secretRef is required (a static key pair or an assume-role secret); the default credential chain is never used');
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(secret.reveal());
  } catch {
    bad('must be a JSON object');
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) bad('must be a JSON object');
  const kind = d.kind;
  if (kind !== 'static' && kind !== 'assume-role') return bad('kind must be "static" or "assume-role"');
  for (const k of Object.keys(d)) if (!KEYS[kind].includes(k)) bad(`unknown key ${k.replace(/[^\w]/g, '?').slice(0, 40)}`);
  const str = (k: string, re = LINE_RE, fallback?: string): string => {
    const v = d[k] ?? fallback;
    return typeof v === 'string' && re.test(v) ? v : bad(`${k} is missing or malformed`);
  };
  const keys = { accessKeyId: str('accessKeyId'), secretAccessKey: str('secretAccessKey') };
  if (kind === 'static') return { kind, ...keys, ...(d.sessionToken !== undefined ? { sessionToken: str('sessionToken', /^[\x21-\x7e]{1,8192}$/) } : {}) };
  const duration = d.durationSeconds ?? 3600;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 900 || duration > 43200) bad('durationSeconds must be an integer from 900 to 43200');
  return { kind, ...keys, roleArn: str('roleArn', ROLE_ARN_RE), externalId: str('externalId', EXTERNAL_ID_RE), sessionName: str('sessionName', SESSION_RE, 'ratio-focus-retrieval'), durationSeconds: duration as number };
}

/** AWS Signature Version 4 headers for one request (host and x-amz-date are added and signed). */
export function signV4(r: { method: string; host: string; path: string; query?: string; headers?: Record<string, string>; body: string; region: string; service: string; creds: AwsCreds; now: Date }): Record<string, string> {
  const amzDate = r.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const h: Record<string, string> = { ...Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: r.host, 'x-amz-date': amzDate };
  if (r.creds.sessionToken) h['x-amz-security-token'] = r.creds.sessionToken;
  const names = Object.keys(h).sort();
  const canonical = [r.method, r.path, r.query ?? '', names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), sha256(r.body)].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${r.region}/${r.service}/aws4_request`;
  const key = [amzDate.slice(0, 8), r.region, r.service, 'aws4_request'].reduce<Buffer>((k, part) => hmac(k, part), Buffer.from(`AWS4${r.creds.secretAccessKey}`, 'utf8'));
  const signature = hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${r.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** sts:AssumeRole (Query API 2011-06-15) at the regional endpoint, signed with the secret's key pair. */
export async function assumeRole(s: Extract<AwsSecret, { kind: 'assume-role' }>, region: string, deps: { fetch?: typeof fetch; now?: Date } = {}): Promise<AwsCreds> {
  const host = `sts.${region}.amazonaws.com`;
  const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: s.roleArn, RoleSessionName: s.sessionName, ExternalId: s.externalId, DurationSeconds: String(s.durationSeconds) }).toString();
  const headers = signV4({ method: 'POST', host, path: '/', body, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, region, service: 'sts', creds: s, now: deps.now ?? new Date() });
  let status: number;
  let text: string;
  try {
    const res = await (deps.fetch ?? fetch)(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    status = res.status;
    text = (await res.text()).slice(0, 64 * 1024);
  } catch {
    throw new ManagedError('AUTH_UNREACHABLE', 'sts:AssumeRole could not be reached');
  }
  const tag = (n: string) => new RegExp(`<${n}>([^<]{1,8192})</${n}>`).exec(text)?.[1];
  if (status !== 200) throw new ManagedError('AUTH_FAILED', `sts:AssumeRole was refused (HTTP ${status} ${/^[A-Za-z.]{1,64}$/.exec(tag('Code') ?? '')?.[0] ?? 'error'})`);
  const [accessKeyId, secretAccessKey, sessionToken, exp] = ['AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration'].map(tag);
  const expiration = new Date(exp ?? '');
  if (!accessKeyId || !secretAccessKey || !sessionToken || Number.isNaN(expiration.getTime())) throw new ManagedError('AUTH_FAILED', 'sts:AssumeRole returned no usable credentials');
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

/**
 * The source's S3 client and its credential provider (assume-role sessions are cached until 5 minutes
 * before expiry). `endpoint` (validated by the caller) switches to path-style addressing.
 */
export function s3ClientFromSecret(o: { secret: SecretValue | undefined; region: string; endpoint?: string; registerSecret: (v: string) => void; fetch?: typeof fetch; now?: () => Date }): { client: S3Client; kind: AwsSecret['kind']; credentials: () => Promise<AwsCreds> } {
  const s = parseAwsSecret(o.secret);
  for (const v of [s.secretAccessKey, s.kind === 'static' ? s.sessionToken : s.externalId]) if (v) o.registerSecret(v);
  let cached: AwsCreds | undefined;
  const credentials = s.kind === 'static'
    ? async (): Promise<AwsCreds> => ({ accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, ...(s.sessionToken ? { sessionToken: s.sessionToken } : {}) })
    : async (): Promise<AwsCreds> => {
      const now = o.now?.() ?? new Date();
      if (!cached || cached.expiration!.getTime() - now.getTime() < 5 * 60_000) {
        cached = await assumeRole(s, o.region, { fetch: o.fetch, now });
        for (const v of [cached.accessKeyId, cached.secretAccessKey, cached.sessionToken!]) o.registerSecret(v);
      }
      return cached;
    };
  const client = new S3Client({
    region: o.region, credentials, ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    ignoreConfiguredEndpointUrls: true, useFipsEndpoint: false, useDualstackEndpoint: false, disableS3ExpressSessionAuth: true,
    defaultsMode: 'legacy', maxAttempts: 3, retryMode: 'standard', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { client, kind: s.kind, credentials };
}
