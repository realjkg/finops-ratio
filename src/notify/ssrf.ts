// SSRF guard for every outbound URL in alert delivery (D-17: network egress is a
// restricted class).
//
// TRUST BOUNDARY: the URL string, the DNS answers and the host allowlist are
// the inputs. The URL is tenant-configured (resolved from a secret handle) and
// is treated as hostile. The guard is deny-by-default and returns a FIXED code
// that never echoes the URL, host or address.
//
// What it enforces, in order:
//   1. a bounded, printable-ASCII string with no backslashes;
//   2. https only, no userinfo, and port 443 unless the tenant allowlisted the
//      port (every other port is refused, including well-known service ports);
//   3. the host: IP literals in ANY spelling (decimal, octal, hex, short,
//      IPv4-mapped IPv6) are classified and then refused (a public IP literal is
//      refused too: webhooks must use DNS names); names pass a syntax check, a
//      blocked-suffix list (localhost, .internal, .local, ...) and the
//      per-tenant host allowlist when one is given;
//   4. DNS through the INJECTED resolver, with a time cap. EVERY answer is
//      re-checked against the IP classifier (DNS rebinding and wildcard-DNS
//      names that point at private space are caught here);
//   5. pinning: the checked address is returned and the transport must connect
//      to it, so a second resolution can never swap in a private address.
//
// Redirects are never followed (see httpDelivery.ts). This module opens no
// sockets.

import { classifyHostLiteral, classifyIp, type IpBlockReason } from './ip';
import type { DnsResolver, Sleep } from './types';

export type SsrfCode =
  | 'url_invalid'
  | 'url_too_long'
  | 'scheme_not_https'
  | 'userinfo_present'
  | 'port_denied'
  | 'host_invalid'
  | 'host_blocked_name'
  | 'host_not_allowed'
  | 'ip_literal_denied'
  | 'dns_failed'
  | 'dns_timeout'
  | 'dns_empty'
  | 'dns_too_many'
  | 'dns_invalid_answer'
  | `blocked_${IpBlockReason}`;

export interface EgressPolicy {
  /**
   * Per-tenant host allowlist: exact names (`hooks.slack.com`) or one-level-or-
   * deeper wildcards (`*.example.com`, which does NOT match `example.com`).
   * `undefined` means no host restriction (the IP and DNS checks still apply);
   * an empty array allows no host at all.
   */
  readonly allowedHosts?: readonly string[];
  /** Ports other than 443 that this tenant explicitly allows. */
  readonly allowedPorts?: readonly number[];
  readonly maxUrlChars?: number;
  readonly dnsTimeoutMs?: number;
}

export interface PinnedTarget {
  /** Normalized https URL: no userinfo, no fragment. */
  readonly href: string;
  /** Lower-case ASCII host name for SNI and the Host header. */
  readonly hostname: string;
  readonly port: number;
  /** The checked address the transport must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  /** Every checked answer (the first is `address`). */
  readonly addresses: readonly string[];
}

export type GuardResult =
  | { readonly ok: true; readonly target: PinnedTarget }
  | { readonly ok: false; readonly code: SsrfCode };

export const DEFAULT_MAX_URL_CHARS = 2048;
export const DEFAULT_DNS_TIMEOUT_MS = 5000;
/** More answers than this is treated as hostile. */
export const MAX_DNS_ANSWERS = 16;
export const MAX_ALLOWED_PORTS = 10;

/** Suffixes that name local or internal namespaces. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
];

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-case ASCII host name with 2+ labels and valid labels, or null. */
export function normalizeHostName(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null; // single-label names resolve through search domains
  return labels.every((l) => LABEL_RE.test(l)) ? h : null;
}

function hasBlockedSuffix(host: string): boolean {
  return BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Normalize an allowlist entry (`host` or `*.host`) or return null when invalid. */
export function normalizeAllowlistEntry(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const wildcard = entry.startsWith('*.');
  const host = normalizeHostName(wildcard ? entry.slice(2) : entry);
  if (host === null || hasBlockedSuffix(host) || classifyHostLiteral(host) !== null) return null; // names only, never IP literals
  return wildcard ? `*.${host}` : host;
}

export function hostMatchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  for (const raw of allowlist) {
    const entry = normalizeAllowlistEntry(raw);
    if (entry === null) continue; // an invalid entry can never match
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1))) return true; // keeps the leading dot: a real subdomain
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Race `work` against the injected sleep. The timer is cancelled through the
 * abort signal when the work finishes first. If `work` rejects, so does this.
 */
export async function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
  sleep: Sleep,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  const cancel = new AbortController();
  const timer = sleep(ms, cancel.signal).then(() => ({ timedOut: true as const }));
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), timer]);
  } finally {
    cancel.abort();
  }
}

function deny(code: SsrfCode): GuardResult {
  return { ok: false, code };
}

/**
 * Check a URL and resolve it to a pinned, checked target. Never throws and never
 * echoes the URL. Call it again for every attempt: a retry must re-resolve and
 * re-check.
 */
export async function guardOutboundUrl(
  rawUrl: unknown,
  policy: EgressPolicy,
  deps: { readonly resolve: DnsResolver; readonly sleep: Sleep },
): Promise<GuardResult> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return deny('url_invalid');
  if (rawUrl.length > (policy.maxUrlChars ?? DEFAULT_MAX_URL_CHARS)) return deny('url_too_long');
  if (/[^\x21-\x7e]/.test(rawUrl) || rawUrl.includes('\\')) return deny('url_invalid');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('url_invalid');
  }
  if (url.protocol !== 'https:') return deny('scheme_not_https');
  if (url.username !== '' || url.password !== '') return deny('userinfo_present');

  // The URL parser drops the default port, so a non-empty port is non-default.
  let port = 443;
  if (url.port !== '') {
    port = Number(url.port);
    const allowed = policy.allowedPorts ?? [];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !allowed.includes(port)) return deny('port_denied');
  }

  const rawHost = url.hostname;
  if (rawHost.length === 0) return deny('host_invalid');

  // IP literal in any spelling: classify first so the reason is specific.
  const literal = classifyHostLiteral(rawHost);
  if (literal !== null) {
    return deny(literal.allowed ? 'ip_literal_denied' : `blocked_${literal.reason}`);
  }

  // Local namespaces first, so `localhost` is reported as blocked rather than as a single label.
  const lowered = rawHost.toLowerCase().replace(/\.$/, '');
  if (hasBlockedSuffix(lowered)) return deny('host_blocked_name');
  const hostname = normalizeHostName(rawHost);
  if (hostname === null) return deny('host_invalid');
  if (policy.allowedHosts !== undefined && !hostMatchesAllowlist(hostname, policy.allowedHosts)) {
    return deny('host_not_allowed');
  }

  // DNS, through the injected resolver, with a time cap.
  let answers: readonly string[];
  try {
    const raced = await raceTimeout(
      Promise.resolve().then(() => deps.resolve(hostname)),
      policy.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
      deps.sleep,
    );
    if (raced.timedOut) return deny('dns_timeout');
    answers = raced.value;
  } catch {
    return deny('dns_failed');
  }
  if (!Array.isArray(answers)) return deny('dns_invalid_answer');
  if (answers.length === 0) return deny('dns_empty');
  if (answers.length > MAX_DNS_ANSWERS) return deny('dns_too_many');

  // Re-check EVERY resolved address: one private answer among public ones is a refusal.
  const checked: string[] = [];
  let family: 4 | 6 = 4;
  for (let i = 0; i < answers.length; i += 1) {
    const verdict = classifyIp(answers[i]);
    if (!verdict.allowed) return deny(verdict.reason === 'unparseable' ? 'dns_invalid_answer' : `blocked_${verdict.reason}`);
    if (i === 0) family = verdict.family;
    checked.push(verdict.canonical);
  }

  url.hash = '';
  return {
    ok: true,
    target: Object.freeze({
      href: url.href,
      hostname,
      port,
      address: checked[0],
      family,
      addresses: Object.freeze(checked),
    }),
  };
}
