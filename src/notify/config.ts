// Per-tenant notification configuration and its strict parser.
//
// TRUST BOUNDARY: tenant config is data an administrator wrote, so it is parsed
// like any other input: unknown fields are refused, every collection has a cap,
// and a bad value yields a FIXED code (never the value). Nothing secret lives
// here: URLs and signing secrets are HANDLES resolved through the SecretStore.
//
// Deny by default: a channel is disabled unless `enabled` is exactly `true`; a
// tenant with an empty `allowedHosts` can reach no URL channel; `severities`
// must be listed explicitly.

import { SEVERITIES, isValidTenantId, type Severity } from './alertEvent';
import { MAX_EMAIL_RECIPIENTS, isValidDisplayName, parseEmailAddress } from './email';
import { isValidSecretHandle } from './secrets';
import { MAX_ALLOWED_PORTS, normalizeAllowlistEntry } from './ssrf';
import type { ChannelKind } from './types';

export const CONFIG_LIMITS = Object.freeze({ channels: 10, allowedHosts: 50, allowedPorts: MAX_ALLOWED_PORTS, recipients: MAX_EMAIL_RECIPIENTS });

interface ChannelBase {
  /** Unique within the tenant. */
  readonly id: string;
  /** Must be exactly true to send; anything else (or absent) is disabled. */
  readonly enabled: boolean;
  /** Severities this channel receives (per-tenant routing). */
  readonly severities: readonly Severity[];
}

export interface SlackChannelSpec extends ChannelBase {
  readonly kind: 'slack';
  readonly urlHandle: string;
}

export interface WebhookChannelSpec extends ChannelBase {
  readonly kind: 'webhook';
  readonly urlHandle: string;
  readonly secretHandle: string;
}

export interface EmailChannelSpec extends ChannelBase {
  readonly kind: 'email';
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
}

export type ChannelSpec = SlackChannelSpec | WebhookChannelSpec | EmailChannelSpec;

export interface TenantNotifyConfig {
  readonly tenant: string;
  /** Hosts URL channels may reach (exact or `*.suffix`). Empty means none. */
  readonly allowedHosts: readonly string[];
  /** Extra ports beyond 443 this tenant allows. */
  readonly allowedPorts: readonly number[];
  readonly channels: readonly ChannelSpec[];
}

export type ConfigErrorCode =
  | 'malformed'
  | 'unknown_field'
  | 'tenant_invalid'
  | 'hosts_invalid'
  | 'too_many_hosts'
  | 'ports_invalid'
  | 'too_many_ports'
  | 'channels_invalid'
  | 'too_many_channels'
  | 'channel_invalid'
  | 'duplicate_channel_id'
  | 'handle_invalid'
  | 'recipients_invalid'
  | 'too_many_recipients';

export type ConfigParse =
  | { readonly ok: true; readonly config: TenantNotifyConfig }
  | { readonly ok: false; readonly code: ConfigErrorCode };

const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KINDS: readonly ChannelKind[] = ['slack', 'webhook', 'email'];

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(rec: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(rec).every((k) => allowed.includes(k));
}

const fail = (code: ConfigErrorCode): ConfigParse => ({ ok: false, code });

function parseChannel(raw: unknown): { ok: true; value: ChannelSpec } | { ok: false; code: ConfigErrorCode } {
  if (!isRecord(raw)) return { ok: false, code: 'channel_invalid' };
  const { id, kind, enabled, severities } = raw;
  if (typeof id !== 'string' || !CHANNEL_ID_RE.test(id)) return { ok: false, code: 'channel_invalid' };
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return { ok: false, code: 'channel_invalid' };
  if (enabled !== undefined && typeof enabled !== 'boolean') return { ok: false, code: 'channel_invalid' };
  if (!Array.isArray(severities) || severities.length === 0 || severities.length > SEVERITIES.length) {
    return { ok: false, code: 'channel_invalid' };
  }
  const sev: Severity[] = [];
  for (const s of severities) {
    if (typeof s !== 'string' || !(SEVERITIES as readonly string[]).includes(s) || sev.includes(s as Severity)) {
      return { ok: false, code: 'channel_invalid' };
    }
    sev.push(s as Severity);
  }
  const base = { id, enabled: enabled === true, severities: Object.freeze(sev) };

  if (kind === 'slack') {
    if (!onlyKeys(raw, ['id', 'kind', 'enabled', 'severities', 'urlHandle'])) return { ok: false, code: 'unknown_field' };
    if (!isValidSecretHandle(raw.urlHandle)) return { ok: false, code: 'handle_invalid' };
    return { ok: true, value: Object.freeze({ ...base, kind: 'slack' as const, urlHandle: raw.urlHandle }) };
  }
  if (kind === 'webhook') {
    if (!onlyKeys(raw, ['id', 'kind', 'enabled', 'severities', 'urlHandle', 'secretHandle'])) return { ok: false, code: 'unknown_field' };
    if (!isValidSecretHandle(raw.urlHandle) || !isValidSecretHandle(raw.secretHandle)) return { ok: false, code: 'handle_invalid' };
    return {
      ok: true,
      value: Object.freeze({ ...base, kind: 'webhook' as const, urlHandle: raw.urlHandle, secretHandle: raw.secretHandle }),
    };
  }
  if (!onlyKeys(raw, ['id', 'kind', 'enabled', 'severities', 'from', 'fromName', 'to'])) return { ok: false, code: 'unknown_field' };
  const from = parseEmailAddress(raw.from);
  if (from === null) return { ok: false, code: 'recipients_invalid' };
  if (raw.fromName !== undefined && !isValidDisplayName(raw.fromName)) return { ok: false, code: 'recipients_invalid' };
  if (!Array.isArray(raw.to) || raw.to.length === 0) return { ok: false, code: 'recipients_invalid' };
  if (raw.to.length > CONFIG_LIMITS.recipients) return { ok: false, code: 'too_many_recipients' };
  const to: string[] = [];
  for (const r of raw.to) {
    const addr = parseEmailAddress(r);
    if (addr === null) return { ok: false, code: 'recipients_invalid' };
    to.push(addr);
  }
  return {
    ok: true,
    value: Object.freeze({
      ...base,
      kind: 'email' as const,
      from,
      ...(raw.fromName === undefined ? {} : { fromName: raw.fromName as string }),
      to: Object.freeze(to),
    }),
  };
}

/** Strict parse of an untrusted tenant config. Never throws; never echoes input. */
export function parseTenantNotifyConfig(input: unknown): ConfigParse {
  try {
    if (!isRecord(input)) return fail('malformed');
    if (!onlyKeys(input, ['tenant', 'allowedHosts', 'allowedPorts', 'channels'])) return fail('unknown_field');
    if (!isValidTenantId(input.tenant)) return fail('tenant_invalid');

    const hostsRaw = input.allowedHosts ?? [];
    if (!Array.isArray(hostsRaw)) return fail('hosts_invalid');
    if (hostsRaw.length > CONFIG_LIMITS.allowedHosts) return fail('too_many_hosts');
    const hosts: string[] = [];
    for (const h of hostsRaw) {
      const norm = normalizeAllowlistEntry(h);
      if (norm === null) return fail('hosts_invalid');
      hosts.push(norm);
    }

    const portsRaw = input.allowedPorts ?? [];
    if (!Array.isArray(portsRaw)) return fail('ports_invalid');
    if (portsRaw.length > CONFIG_LIMITS.allowedPorts) return fail('too_many_ports');
    const ports: number[] = [];
    for (const p of portsRaw) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) return fail('ports_invalid');
      ports.push(p);
    }

    const channelsRaw = input.channels ?? [];
    if (!Array.isArray(channelsRaw)) return fail('channels_invalid');
    if (channelsRaw.length > CONFIG_LIMITS.channels) return fail('too_many_channels');
    const channels: ChannelSpec[] = [];
    for (const c of channelsRaw) {
      const parsed = parseChannel(c);
      if (!parsed.ok) return fail(parsed.code);
      if (channels.some((x) => x.id === parsed.value.id)) return fail('duplicate_channel_id');
      channels.push(parsed.value);
    }

    return {
      ok: true,
      config: Object.freeze({
        tenant: input.tenant,
        allowedHosts: Object.freeze(hosts),
        allowedPorts: Object.freeze(ports),
        channels: Object.freeze(channels),
      }),
    };
  } catch {
    return fail('malformed');
  }
}
