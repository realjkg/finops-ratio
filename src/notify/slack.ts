// Slack incoming-webhook channel.
//
// TRUST BOUNDARY: every string in an AlertEvent is untrusted text. Slack
// message text is mrkdwn, where `<!channel>`, `<@U123>`, `<#C123>`,
// `<!subteam^S1>` and `<https://evil|click here>` are LIVE constructs. This
// module therefore:
//   - escapes `&`, `<` and `>` in every untrusted string (the three characters
//     Slack requires), so none of those constructs can be formed from event
//     text; the only `<...>` in a payload are the link constructs this module
//     builds itself from URLs that alertEvent.ts validated;
//   - rewrites scheme URLs in untrusted text (`https://x` becomes `https[:]//x`)
//     so they are not auto-linked;
//   - renders resource ids inside inline code;
//   - sets unfurl_links and unfurl_media to false;
//   - truncates on character boundaries to Slack's block limits AFTER escaping
//     (escaping can expand text four-fold), never splitting an entity.
// Known gap (README): Slack's client may still auto-link a bare domain name or
// an email address in plain text; a payload cannot prevent that.
//
// The webhook URL is a secret: it is resolved from a handle on every attempt
// and goes only to the SSRF-guarded POST.

import type { AlertEvent, Severity } from './alertEvent';
import { postGuarded, type HttpChannelDeps } from './httpDelivery';
import { resolveSecret } from './secrets';
import type { AlertChannel, ChannelResult, SendContext } from './types';

export const SLACK_SECTION_CHARS = 2900;
export const SLACK_FALLBACK_CHARS = 300;
export const SLACK_TITLE_CHARS = 300;
export const TRUNCATION_MARK = '…';

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Rewrite `scheme://` so Slack does not auto-link a scheme URL in untrusted text. */
export function defangUrls(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi, '$1[:]//');
}

/** Escape `&`, `<`, `>` (the characters Slack mrkdwn requires) after defanging scheme URLs. */
export function escapeSlackText(s: string): string {
  return defangUrls(s).replace(/[&<>]/g, (c) => ENTITY[c]);
}

/**
 * Escape then truncate to at most `budget` characters of OUTPUT, ending with an
 * ellipsis when cut. Cuts between source characters, so an entity such as
 * `&lt;` is never split.
 */
export function slackText(raw: string, budget: number): string {
  const pieces = Array.from(defangUrls(raw)).map((c) => ENTITY[c] ?? c);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  if (total <= budget) return pieces.join('');
  let out = '';
  for (const p of pieces) {
    if (out.length + p.length > budget - TRUNCATION_MARK.length) break;
    out += p;
  }
  return out + TRUNCATION_MARK;
}

/** Inline code span: backticks cannot be escaped in mrkdwn, so they are replaced. */
export function slackCode(raw: string, budget: number): string {
  return `\`${slackText(raw.replace(/`/g, "'"), budget)}\``;
}

/** A link URL safe inside `<url|label>`: `&` is an entity, `<`, `>` and `|` are percent-encoded. */
function slackLinkUrl(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');
}

const SEVERITY_LABEL: Record<Severity, string> = { info: 'INFO', warning: 'WARNING', critical: 'CRITICAL' };

interface SlackBlock {
  readonly type: 'section' | 'context';
  readonly text?: { readonly type: 'mrkdwn'; readonly text: string };
  readonly elements?: readonly { readonly type: 'mrkdwn'; readonly text: string }[];
}

export interface SlackPayload {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
  readonly unfurl_links: false;
  readonly unfurl_media: false;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** Lines joined with `\n`, stopping (with a count) before the section budget is exceeded. */
function boundedLines(lines: readonly string[], budget: number): string {
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    const next = out === '' ? lines[i] : `${out}\n${lines[i]}`;
    const more = lines.length - i - 1;
    const tail = more > 0 ? `\n_and ${more} more_` : '';
    if (next.length + tail.length > budget) {
      return `${out}\n_and ${lines.length - i} more_`.trimStart();
    }
    out = next;
  }
  return out;
}

export function buildSlackPayload(event: AlertEvent): SlackPayload {
  const label = SEVERITY_LABEL[event.severity];
  const title = slackText(event.title, SLACK_TITLE_CHARS);
  const head = `*[${label}]* ${title}`;
  const bodyBudget = SLACK_SECTION_CHARS - head.length - 1;
  const mainText = event.body === '' ? head : `${head}\n${slackText(event.body, Math.max(bodyBudget, 0))}`;

  const blocks: SlackBlock[] = [section(mainText)];

  if (event.resources.length > 0) {
    const lines = event.resources.map((r) => {
      const base = `• ${slackCode(r.kind, 40)} ${slackCode(r.id, 200)}`;
      return r.label === undefined ? base : `${base} ${slackText(r.label, 100)}`;
    });
    blocks.push(section(boundedLines(lines, SLACK_SECTION_CHARS)));
  }

  if (event.links.length > 0) {
    const lines = event.links.map((l) => `<${slackLinkUrl(l.url)}|${slackText(l.label, 80)}>`);
    blocks.push(section(boundedLines(lines, SLACK_SECTION_CHARS)));
  }

  const meta = `tenant ${slackCode(event.tenant, 80)} · occurred ${slackCode(event.occurredAt, 40)} · key ${slackCode(event.dedupeKey, 220)}`;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: meta }] });

  return {
    text: slackText(`[${label}] ${event.title}`, SLACK_FALLBACK_CHARS),
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

export interface SlackChannelConfig {
  readonly id: string;
  /** Handle (not the URL) of the incoming-webhook URL in the secret store. */
  readonly urlHandle: string;
}

export function createSlackChannel(cfg: SlackChannelConfig, deps: HttpChannelDeps): AlertChannel {
  return {
    kind: 'slack',
    id: cfg.id,
    async send(event: AlertEvent, ctx: SendContext): Promise<ChannelResult> {
      if (event.tenant !== ctx.tenant) return { ok: false, code: 'internal_error', retryable: false };
      const secret = await resolveSecret(deps.secrets, ctx.tenant, cfg.urlHandle, 'url');
      if (!secret.ok) return { ok: false, code: secret.code, retryable: secret.code === 'secret_unavailable' };
      const body = JSON.stringify(buildSlackPayload(event));
      return postGuarded(
        secret.value,
        body,
        { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'Ratio-Notify/1' },
        deps,
      );
    },
  };
}
