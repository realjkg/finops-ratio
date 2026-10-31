// M0a: the worker's check of RATIO_ENGAGEMENT_CONFIG before a managed fetch.
// R1 (src/engagement/config.ts) owns the schema, but its module imports
// `@/data/models`, which the worker build (tsconfig.worker.json, no paths)
// cannot resolve. This is a LOCAL, worker-safe check of the keys a fetch
// depends on: top-level and source keys, tenantId bound to --tenant, source ids
// (format, no duplicates) and every retrieval block (connector, params depth and
// size, credential-looking values, aws-data-exports' bucket/prefix/exportName
// field rules, secretRef as a NAME), then R1's release policy: a managed
// connector must be on the approved list, which the worker passes in as the
// connectors of its registry (R1's SUPPORTED_IN_THIS_BUILD.managedConnectors is
// pinned equal to it). Its constants are
// copies of R1's; engagementSpec.test.ts pins them to R1's exports and source
// text and runs one table of accept/reject cases through both validators.
// Problems name the KEY, never the value.
import fs from 'fs';
import path from 'path';

export const MANAGED_CONNECTORS = ['aws-data-exports', 'azure-cost-export', 'gcp-bigquery-export', 'oci-cost-report', 'nutanix', 'servicenow', 'pointfive', 'opencost', 'openai-usage', 'anthropic-usage'] as const;
export const CREDENTIAL_RE: readonly RegExp[] = [/-----BEGIN [A-Z ]*-----/, /^eyJ[\w-]{8,}\.[\w-]{8,}\.?[\w-]*$/, /^(AKIA|ASIA)[A-Z0-9]{16}$/, /^[A-Za-z0-9+/_=-]{40,}$/];
export const SECRET_REF_RE = /^[A-Za-z_][A-Za-z0-9_./-]{0,127}$/;
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const MAX_PARAM_ENTRIES = 100;
const MAX_LEAF_CHARS = 1000;
const MAX_SOURCES = 50;
const MAX_BYTES = 1024 * 1024;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOP_KEYS = ['engagementId', 'tenantId', 'displayName', 'currency', 'sources', 'allocation', 'budgets', 'scenarios', 'outcomesFile'];
const SOURCE_KEYS = ['id', 'providers', 'layout', 'retrieval', 'metadata'];
const RETRIEVAL_KEYS = ['kind', 'connector', 'params', 'secretRef'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface ManagedSpec { connector: string; params: Record<string, unknown>; secretRef?: string }

export class ManagedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const safeKey = (k: string) => k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40);
const looksLikeCredential = (v: string) => CREDENTIAL_RE.some((r) => r.test(v));

// Copy of R1's AWS location rules (owner-approved 2026-10-30; see src/engagement/config.ts).
const AWS_LOCATION_PARAMS = ['bucket', 'prefix', 'exportName'];
export const AWS_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AWS_BUCKET_RESERVED_RE = /\.\.|^\d{1,3}(\.\d{1,3}){3}$|^(xn--|sthree-|amzn-s3-demo-)|(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/;
export const AWS_EXPORT_NAME_RE = /^[0-9A-Za-z_-]{1,128}$/;
export const AWS_KEY_ID_RE = /(^|[^A-Z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/;
export const AWS_INLINE_CREDENTIAL_RE = /(secret|password|passwd|token|credential|signature|access[_-]?key)[=:]|^[^/@]*:[^/@]*@/i;
export const S3_KEY_MAX_BYTES = 1024;
export const AWS_FILE_PART_RESERVE_BYTES = 256;
// eslint-disable-next-line no-control-regex
const C0_C1_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** The problem (never the value) of one AWS location param, or null. */
function awsLocationProblem(name: string, v: unknown, params: Record<string, unknown>): string | null {
  if (typeof v !== 'string') return 'must be a string';
  if (v.split('/').some((seg) => CREDENTIAL_RE.slice(0, 3).some((r) => r.test(seg))) || AWS_KEY_ID_RE.test(v) || AWS_INLINE_CREDENTIAL_RE.test(v)) return 'looks like a credential value; reference a secret by name with secretRef';
  if (name === 'bucket') return AWS_BUCKET_RE.test(v) && !AWS_BUCKET_RESERVED_RE.test(v) ? null : 'must be an S3 general purpose bucket name (3 to 63 lowercase letters, digits, dots and hyphens; letter or digit at both ends; no consecutive dots, IP address form or reserved prefix or suffix)';
  if (name === 'exportName') return AWS_EXPORT_NAME_RE.test(v) ? null : 'must be a Data Exports export name (1 to 128 letters, digits, underscores and hyphens)';
  if (v === '') return null;
  if (C0_C1_RE.test(v) || v.includes('\ufffd') || Buffer.from(v, 'utf8').toString('utf8') !== v || v.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'must be valid UTF-8 without control characters, leading or trailing slash, or empty, . or .. segments';
  }
  const exportName = typeof params.exportName === 'string' ? params.exportName : '';
  if (Buffer.byteLength(`${v}/${exportName}/metadata/BILLING_PERIOD=YYYY-MM/`) + AWS_FILE_PART_RESERVE_BYTES > S3_KEY_MAX_BYTES) {
    return `with exportName, the longest object key the AWS retriever builds would exceed the ${S3_KEY_MAX_BYTES}-byte S3 key limit (${AWS_FILE_PART_RESERVE_BYTES} bytes reserved for the file part)`;
  }
  return null;
}

function unknownKeys(o: Obj, allowed: readonly string[], key: string, p: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.push(`${key === '' ? safeKey(k) : `${key}.${safeKey(k)}`}: unknown key`);
}

function leafProblems(v: unknown, key: string, p: string[]): void {
  const str = (x: string, k: string) => {
    if (x.length > MAX_LEAF_CHARS || CONTROL_RE.test(x)) p.push(`${k}: must be a single-line string of at most ${MAX_LEAF_CHARS} characters`);
    else if (looksLikeCredential(x)) p.push(`${k}: looks like a credential value; reference a secret by name with secretRef`);
  };
  if (typeof v === 'string') str(v, key);
  else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return;
  else if (Array.isArray(v) && v.length <= MAX_LEAF_CHARS) v.forEach((x, i) => (typeof x === 'string' ? str(x, `${key}[${i}]`) : p.push(`${key}[${i}]: must be a single-line string`)));
  else p.push(`${key}: must be a string, number, boolean or array of strings`);
}

/** R1-equivalent problems of one `sources[].retrieval` block (absent = file-drop). */
export function retrievalProblems(v: unknown, key: string): string[] {
  const p: string[] = [];
  if (v === undefined) return p;
  if (!isObj(v)) return [`${key}: must be an object`];
  unknownKeys(v, RETRIEVAL_KEYS, key, p);
  if (v.kind === 'file-drop') {
    for (const k of ['connector', 'params', 'secretRef']) if (k in v) p.push(`${key}.${k}: only allowed with kind managed`);
    return p;
  }
  if (v.kind !== 'managed') return [...p, `${key}.kind: must be one of: file-drop, managed`];
  if (typeof v.connector !== 'string' || !(MANAGED_CONNECTORS as readonly string[]).includes(v.connector)) p.push(`${key}.connector: must be one of: ${MANAGED_CONNECTORS.join(', ')}`);
  if ('params' in v) {
    const pk = `${key}.params`;
    if (!isObj(v.params) || Object.keys(v.params).length > MAX_PARAM_ENTRIES) p.push(`${pk}: must be an object of at most ${MAX_PARAM_ENTRIES} entries`);
    else
      for (const [name, val] of Object.entries(v.params)) {
        const k = `${pk}.${safeKey(name)}`;
        if (v.connector === 'aws-data-exports' && AWS_LOCATION_PARAMS.includes(name)) {
          const why = awsLocationProblem(name, val, v.params);
          if (why) p.push(`${k}: ${why}`);
        } else if (isObj(val)) {
          for (const [n2, v2] of Object.entries(val)) {
            if (isObj(v2)) p.push(`${k}.${safeKey(n2)}: nesting deeper than 2 levels is not allowed`);
            else leafProblems(v2, `${k}.${safeKey(n2)}`, p);
          }
        } else leafProblems(val, k, p);
      }
  }
  if ('secretRef' in v) {
    const r = v.secretRef;
    if (!(typeof r === 'string' && SECRET_REF_RE.test(r) && !looksLikeCredential(r))) p.push(`${key}.secretRef: must be the NAME of a secret (letters, digits, underscore, dot, slash, hyphen), not a secret value`);
  }
  return p;
}

/**
 * R1-equivalent problems of the keys a managed fetch depends on (empty = acceptable). `approved`
 * is the worker's list of managed connectors (its registry); without it every managed connector
 * is refused (fail closed), as R1 refuses one outside SUPPORTED_IN_THIS_BUILD.managedConnectors.
 */
export function engagementProblems(input: unknown, approved: readonly string[] = []): string[] {
  if (!isObj(input)) return ['config: must be a JSON object'];
  const p: string[] = [];
  unknownKeys(input, TOP_KEYS, '', p);
  if (typeof input.tenantId !== 'string' || !UUID_RE.test(input.tenantId)) p.push('tenantId: must be a canonical UUID');
  const sources = input.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES) return [...p, `sources: must be an array of 1 to ${MAX_SOURCES} items`];
  const seen = new Set<string>();
  sources.forEach((s, i) => {
    const k = `sources[${i}]`;
    if (!isObj(s)) return void p.push(`${k}: must be an object`);
    unknownKeys(s, SOURCE_KEYS, k, p);
    if (typeof s.id !== 'string' || !SOURCE_ID_RE.test(s.id)) p.push(`${k}.id: must be 1 to 63 characters of lowercase letters, digits, dot, underscore and hyphen`);
    else if (seen.has(s.id)) p.push(`${k}.id: duplicate source id`);
    else seen.add(s.id);
    const rp = retrievalProblems(s.retrieval, `${k}.retrieval`);
    p.push(...rp);
    const r = s.retrieval;
    if (!rp.length && isObj(r) && r.kind === 'managed' && !approved.includes(r.connector as string)) p.push(`${k}.retrieval.connector: not implemented in this build`);
  });
  return p;
}

/** The managed retrieval of one source entry (`retrieval` validated as R1 does). */
export function managedSpecFrom(source: unknown): ManagedSpec {
  const r = (source as { retrieval?: unknown } | null)?.retrieval;
  const problems = r === undefined ? ['retrieval: absent (file-drop)'] : retrievalProblems(r, 'retrieval');
  if (problems.length || !isObj(r) || r.kind !== 'managed') {
    throw new ManagedError('SOURCE_NOT_MANAGED', `the source config has no valid managed retrieval block (${problems.slice(0, 3).join('; ') || 'kind is not managed'})`);
  }
  return { connector: r.connector as string, params: (r.params as Record<string, unknown>) ?? {}, ...(r.secretRef ? { secretRef: r.secretRef as string } : {}) };
}

/**
 * Reads RATIO_ENGAGEMENT_CONFIG (absolute, at most 1 MiB), checks it (engagementProblems against `approved`), binds it
 * to `tenantId` (the config names the ONE tenant of this instance) and returns the managed retrieval
 * of source `sourceId`.
 */
export function managedSpecFromEngagementFile(file: string | undefined, sourceId: string, tenantId: string, approved: readonly string[] = []): ManagedSpec {
  const invalid = (m: string) => new ManagedError('ENGAGEMENT_CONFIG_INVALID', `RATIO_ENGAGEMENT_CONFIG: ${m}`);
  if (!file || !path.isAbsolute(file)) throw invalid('must be the absolute path of the engagement config');
  let parsed: unknown;
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw invalid('file is larger than 1 MiB');
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw e instanceof ManagedError ? e : invalid('file is missing, unreadable or not valid JSON');
  }
  const problems = engagementProblems(parsed, approved);
  if (problems.length) throw invalid(problems.slice(0, 5).join('; '));
  const root = parsed as { tenantId: string; sources: Array<{ id: string }> };
  if (root.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
    throw new ManagedError('ENGAGEMENT_TENANT_MISMATCH', 'RATIO_ENGAGEMENT_CONFIG: tenantId is not the --tenant of this run (one engagement per instance); nothing was fetched');
  }
  const found = root.sources.find((x) => x.id === sourceId);
  if (!found) throw new ManagedError('SOURCE_NOT_IN_ENGAGEMENT_CONFIG', `the engagement config has no source ${sourceId}`);
  return managedSpecFrom(found);
}
