// Slack channel: mention and link injection through every untrusted field,
// escaping, truncation at Slack's limits, and secret handling.

import { describe, it, expect } from 'vitest';
import { parseAlertEvent, type AlertEvent } from './alertEvent';
import type { HttpChannelDeps } from './httpDelivery';
import {
  SLACK_FALLBACK_CHARS,
  SLACK_SECTION_CHARS,
  buildSlackPayload,
  createSlackChannel,
  defangUrls,
  escapeSlackText,
  slackCode,
  slackText,
  type SlackPayload,
} from './slack';
import { PUBLIC_IP, SLACK_URL, makeClock, makeHttp, makeResolver, makeSecrets, makeSleep, rawEvent, secretsAbsent, type HttpHandler } from './testKit';

function event(overrides: Record<string, unknown> = {}): AlertEvent {
  const r = parseAlertEvent(rawEvent(overrides));
  if (!r.ok) throw new Error(`fixture invalid: ${r.code}`);
  return r.event;
}

/** Every string a Slack client would render from the payload. */
function texts(p: SlackPayload): string[] {
  const out: string[] = [p.text];
  for (const b of p.blocks) {
    if (b.text) out.push(b.text.text);
    for (const e of b.elements ?? []) out.push(e.text);
  }
  return out;
}

const HOSTILE = [
  '<!channel>',
  '<!here>',
  '<!everyone>',
  '<@U12345>',
  '<@U12345|bob>',
  '<#C12345>',
  '<#C12345|general>',
  '<!subteam^S12345>',
  '<!date^1700000000^{date_long}|fallback>',
  '<https://evil.example/login|Click to verify your account>',
  '<mailto:ceo@evil.example|ceo>',
  '<tel:+15555550100>',
  'a < b > c & d',
];

describe('escaping primitives', () => {
  it('escapes & < > exactly as Slack requires', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes & first so pre-escaped entities are not decoded into live constructs', () => {
    expect(escapeSlackText('&lt;!channel&gt;')).toBe('&amp;lt;!channel&amp;gt;');
  });

  it('rewrites scheme URLs so Slack does not auto-link them', () => {
    expect(defangUrls('see https://evil.example/x and HTTP://a.b ftp://c.d')).toBe('see https[:]//evil.example/x and HTTP[:]//a.b ftp[:]//c.d');
    expect(defangUrls('arn:aws:s3:::bucket and a:b')).toBe('arn:aws:s3:::bucket and a:b');
  });

  it('slackText truncates on output length, ends with an ellipsis and never splits an entity', () => {
    const out = slackText('<'.repeat(100), 21);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toMatch(/^(&lt;)+$/);
    expect(slackText('abc', 3)).toBe('abc');
    expect(slackText('abcd', 3)).toBe('ab…');
  });

  it('slackCode replaces backticks and wraps in a code span', () => {
    expect(slackCode('a`b', 50)).toBe("`a'b`");
    expect(slackCode('<!channel>', 50)).toBe('`&lt;!channel&gt;`');
  });
});

describe('buildSlackPayload: mention and link injection', () => {
  it.each(HOSTILE)('%s in the title, body, resource id, resource label and link label stays inert', (hostile) => {
    // sanitizeText keeps these characters (they are printable), so the Slack layer must neutralize them.
    const ev = event({
      title: `T ${hostile}`,
      body: `B ${hostile}`,
      resources: [{ kind: 'workload', id: `id ${hostile}`, label: `L ${hostile}` }],
      links: [{ label: `K ${hostile}`, url: 'https://ratio.example.com/x' }],
    });
    const payload = buildSlackPayload(ev);
    const all = texts(payload).join('\n');
    // The only live constructs are the one link this module builds itself.
    const constructs = all.match(/<[^>]*>/g) ?? [];
    expect(constructs).toEqual([`<https://ratio.example.com/x|K ${escapeSlackText(hostile)}>`]);
    // No raw < or > survives anywhere else.
    const withoutLink = all.replace(/<https:\/\/ratio\.example\.com\/x\|K [^>]*>/, '');
    expect(withoutLink).not.toMatch(/[<>]/);
  });

  it('a hostile event with no links of its own produces no angle brackets at all', () => {
    for (const hostile of HOSTILE) {
      const payload = buildSlackPayload(event({ title: hostile, body: hostile, resources: [{ kind: 'workload', id: hostile, label: hostile }], links: [] }));
      expect(texts(payload).join('\n')).not.toMatch(/[<>]/);
    }
  });

  it('shows the escaped text, so the reader sees what was sent', () => {
    const payload = buildSlackPayload(event({ title: 'x', body: '<!channel> deploy now', resources: [], links: [] }));
    expect(payload.blocks[0].text?.text).toContain('&lt;!channel&gt; deploy now');
  });

  it('does not let a body URL become a link', () => {
    const payload = buildSlackPayload(event({ title: 'x', body: 'verify at https://evil.example/login', resources: [], links: [] }));
    expect(payload.blocks[0].text?.text).toContain('https[:]//evil.example/login');
    expect(payload.blocks[0].text?.text).not.toContain('https://evil.example');
  });

  it('title text cannot close the bold marker into a mention (angle brackets are escaped regardless)', () => {
    const payload = buildSlackPayload(event({ title: '* <!channel> *', links: [], resources: [] }));
    expect(texts(payload).join('')).not.toContain('<!channel>');
  });

  it('builds a real link only from a validated URL, with delimiters neutralized', () => {
    const ev = event({ links: [{ label: 'A | B > C', url: 'https://ratio.example.com/a|b?x=1&y=2' }], resources: [] });
    const payload = buildSlackPayload(ev);
    const linkBlock = payload.blocks.find((b) => b.text?.text.startsWith('<https://'));
    expect(linkBlock?.text?.text).toBe('<https://ratio.example.com/a%7Cb?x=1&amp;y=2|A | B &gt; C>');
    // exactly one raw '>' (the closing one) and one raw '<' in that block
    expect((linkBlock?.text?.text.match(/[<>]/g) ?? []).length).toBe(2);
  });
});

describe('buildSlackPayload: shape', () => {
  it('has a severity header, resource and link sections, a context line, and unfurling off', () => {
    const payload = buildSlackPayload(event());
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
    expect(payload.text).toBe('[CRITICAL] Budget hard threshold crossed');
    expect(payload.blocks.map((b) => b.type)).toEqual(['section', 'section', 'section', 'context']);
    expect(payload.blocks[0].text?.text).toBe(
      '*[CRITICAL]* Budget hard threshold crossed\nWorkload wl-001 reached 91% of its monthly budget.',
    );
    expect(payload.blocks[1].text?.text).toBe('• `workload` `wl-001` Support bot');
    expect(payload.blocks[2].text?.text).toBe('<https://ratio.example.com/findings/f-1|Open in Ratio>');
    expect(payload.blocks[3].elements?.[0].text).toContain('tenant `acme`');
  });

  it('omits empty sections', () => {
    const payload = buildSlackPayload(event({ body: '', resources: [], links: [] }));
    expect(payload.blocks.map((b) => b.type)).toEqual(['section', 'context']);
    expect(payload.blocks[0].text?.text).toBe('*[CRITICAL]* Budget hard threshold crossed');
  });

  it.each([
    ['info', 'INFO'],
    ['warning', 'WARNING'],
    ['critical', 'CRITICAL'],
  ] as const)('labels %s as %s', (severity, label) => {
    expect(buildSlackPayload(event({ severity })).text.startsWith(`[${label}]`)).toBe(true);
  });

  it('serializes to JSON that round-trips', () => {
    const payload = buildSlackPayload(event());
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe('buildSlackPayload: truncation', () => {
  it('truncates a maximal body that expands four-fold when escaped, within the section limit', () => {
    const payload = buildSlackPayload(event({ body: '<'.repeat(4000), resources: [], links: [] }));
    const main = payload.blocks[0].text?.text ?? '';
    expect(main.length).toBeLessThanOrEqual(SLACK_SECTION_CHARS);
    expect(main.endsWith('…')).toBe(true);
    // never ends inside an entity: every '&' is followed by a complete lt; gt; or amp;
    expect(main.replace(/&(lt|gt|amp);/g, '')).not.toContain('&');
    expect(JSON.stringify(payload).length).toBeLessThan(20_000);
  });

  it('does not truncate a body that fits after escaping', () => {
    const body = 'a'.repeat(2000);
    const payload = buildSlackPayload(event({ body, resources: [], links: [] }));
    expect(payload.blocks[0].text?.text.endsWith(body)).toBe(true);
    expect(payload.blocks[0].text?.text.includes('…')).toBe(false);
  });

  it('truncates the title at 300 output characters and the fallback text at 300', () => {
    const payload = buildSlackPayload(event({ title: '&'.repeat(200), body: '', resources: [], links: [] }));
    expect(payload.text.length).toBeLessThanOrEqual(SLACK_FALLBACK_CHARS);
    const head = payload.blocks[0].text?.text ?? '';
    expect(head.startsWith('*[CRITICAL]* ')).toBe(true);
    expect(head.length).toBeLessThanOrEqual('*[CRITICAL]* '.length + 300);
  });

  it('keeps a long resource list inside one section and says how many were left out', () => {
    const resources = Array.from({ length: 20 }, (_, i) => ({ kind: 'workload', id: `${'<'.repeat(150)}${i}`, label: '>'.repeat(90) }));
    const payload = buildSlackPayload(event({ resources, links: [] }));
    const section = payload.blocks[1].text?.text ?? '';
    expect(section.length).toBeLessThanOrEqual(SLACK_SECTION_CHARS);
    expect(section).toMatch(/_and \d+ more_$/);
  });
});

describe('createSlackChannel', () => {
  function setup(handler?: HttpHandler, secrets: Record<string, string | Error> = { 'notify/slack-main': SLACK_URL }, allowedHosts: string[] = ['hooks.slack.com']) {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    const resolver = makeResolver({ 'hooks.slack.com': [PUBLIC_IP], 'internal-looking.example.com': ['10.0.0.9'] });
    const http = makeHttp(handler);
    const store = makeSecrets(secrets);
    const deps: HttpChannelDeps = {
      secrets: store.store,
      resolve: resolver.resolve,
      http: http.transport,
      sleep: sleeper.sleep,
      policy: { allowedHosts },
    };
    const channel = createSlackChannel({ id: 'slack-main', urlHandle: 'notify/slack-main' }, deps);
    return { channel, http, store, resolver };
  }
  const ctx = { tenant: 'acme', attempt: 1 };

  it('posts the JSON payload to the resolved webhook URL, pinned to the checked address', async () => {
    const s = setup();
    const ev = event();
    const res = await s.channel.send(ev, ctx);
    expect(res).toEqual({ ok: true, status: 200, host: 'hooks.slack.com' });
    const req = s.http.requests[0];
    expect(req.url).toBe(SLACK_URL);
    expect(req.address).toBe(PUBLIC_IP);
    expect(req.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(req.body)).toEqual(JSON.parse(JSON.stringify(buildSlackPayload(ev))));
    expect(s.channel.kind).toBe('slack');
    expect(s.channel.id).toBe('slack-main');
  });

  it('resolves the secret on every attempt (so rotation takes effect)', async () => {
    const s = setup();
    await s.channel.send(event(), ctx);
    await s.channel.send(event(), { tenant: 'acme', attempt: 2 });
    expect(s.store.reads).toEqual([
      { tenant: 'acme', handle: 'notify/slack-main' },
      { tenant: 'acme', handle: 'notify/slack-main' },
    ]);
  });

  it('a missing secret is a permanent failure and nothing is sent', async () => {
    const s = setup(undefined, {});
    expect(await s.channel.send(event(), ctx)).toEqual({ ok: false, code: 'secret_missing', retryable: false });
    expect(s.http.requests).toHaveLength(0);
    expect(s.resolver.calls).toEqual([]);
  });

  it('a throwing secret store is retryable and its message never escapes', async () => {
    const s = setup(undefined, { 'notify/slack-main': new Error(`vault error for ${SLACK_URL}`) });
    const res = await s.channel.send(event(), ctx);
    expect(res).toEqual({ ok: false, code: 'secret_unavailable', retryable: true });
    expect(secretsAbsent(res)).toBe(true);
  });

  it('refuses a stored value that is not a clean URL string', async () => {
    const s = setup(undefined, { 'notify/slack-main': 'https://hooks.slack.com/x\r\nHost: evil' });
    expect(await s.channel.send(event(), ctx)).toEqual({ ok: false, code: 'secret_invalid', retryable: false });
    expect(s.http.requests).toHaveLength(0);
  });

  it('applies the SSRF guard and the tenant allowlist to the resolved URL', async () => {
    const privateUrl = setup(undefined, { 'notify/slack-main': 'https://169.254.169.254/latest/meta-data' });
    const res = await privateUrl.channel.send(event(), ctx);
    expect(res).toMatchObject({ ok: false, code: 'ssrf_denied', detail: 'blocked_metadata', retryable: false });
    expect(privateUrl.http.requests).toHaveLength(0);

    const notListed = setup(undefined, { 'notify/slack-main': SLACK_URL }, ['other.example.com']);
    expect(await notListed.channel.send(event(), ctx)).toMatchObject({ code: 'ssrf_denied', detail: 'host_not_allowed' });

    const rebound = setup(undefined, { 'notify/slack-main': 'https://internal-looking.example.com/x' }, ['internal-looking.example.com']);
    expect(await rebound.channel.send(event(), ctx)).toMatchObject({ code: 'ssrf_denied', detail: 'blocked_private' });
  });

  it('refuses an event whose tenant differs from the send context (cross-tenant)', async () => {
    const s = setup();
    expect(await s.channel.send(event({ tenant: 'other' }), ctx)).toEqual({ ok: false, code: 'internal_error', retryable: false });
    expect(s.store.reads).toEqual([]);
    expect(s.http.requests).toHaveLength(0);
  });

  it('maps Slack permanent and transient statuses', async () => {
    const gone = setup(() => ({ status: 410, bodyBytes: 15 }));
    expect(await gone.channel.send(event(), ctx)).toMatchObject({ code: 'http_client_error', retryable: false, status: 410 });
    const limited = setup(() => ({ status: 429, bodyBytes: 0, retryAfter: '5' }));
    expect(await limited.channel.send(event(), ctx)).toMatchObject({ code: 'http_rate_limited', retryable: true, retryAfterMs: 5000 });
  });

  it('never puts the webhook URL in any result', async () => {
    for (const handler of [undefined, () => ({ status: 500, bodyBytes: 0 }), () => ({ status: 302, bodyBytes: 0 })] as const) {
      const s = setup(handler);
      expect(secretsAbsent(await s.channel.send(event(), ctx))).toBe(true);
    }
  });
});
