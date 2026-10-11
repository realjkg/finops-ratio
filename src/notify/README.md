# src/notify: alert delivery (RFQ checklist item 2.5)

Purpose: deliver validated alert events to Slack, a signed generic webhook and
email, behind one channel interface. Network egress is a restricted class
(slice 3-5 D-17), so every transport is injected and the dispatcher is disabled
by default. Importing this directory sends nothing.

## Disabled by default

A send happens only when ALL hold at each attempt: the injected
`egressEnabled()` returns exactly `true` (default: always false); the tenant has
a valid config for the event's tenant; and a channel has `enabled: true` and
lists the event's severity. With the flag off the dispatcher reads no config or
secret, does no DNS, HTTP or mail call, and writes one audit record. The flag is
re-read before every attempt, so it works as a kill switch for in-flight retries.

## Public API (`index.ts`)

- `parseAlertEvent(input)`: strict validation, control, bidi and invisible
  character stripping, caps. Returns a frozen `AlertEvent` or a fixed code.
- `createDispatcher(deps)` and `dispatcher.dispatch(event, { actor })`.
- `createSlackChannel`, `createWebhookChannel`, `createEmailChannel`.
- `signWebhook`, `verifyWebhookSignature` (receiver side), `constantTimeEqual`.
- `guardOutboundUrl(url, policy, { resolve, sleep })`: SSRF guard, returns a
  pinned target (checked address) or a fixed code.
- `classifyIp`, `classifyHostLiteral`, `parseTenantNotifyConfig`,
  `resolveSecret`, `hostOnly`, `InMemoryDeadLetters`, `CircuitBreakers`,
  `DedupeWindow`, `systemClock`/`systemSleep`/`systemRandom`.

Injected seams (`types.ts`): clock, sleep, random, DNS resolver, secret store,
HTTP transport, mail transport, audit sink, dead-letter sink.

## Webhook wire format

Headers `X-Ratio-Timestamp` (unix seconds), `X-Ratio-Signature`
(`v1=` + hex HMAC-SHA256 over `"<timestamp>.<raw body>"`), `X-Ratio-Delivery-Id`.
The verifier checks formats and a 300 s replay window (max 3600 s), compares in
constant time, supports up to 4 secrets for rotation, and returns fixed codes.
Replay inside the window needs the receiver to remember the body's `id`.

## Caps

Title 200, body 4000, resources 20, links 5, link URL 2048, dedupe key 200
characters. Request body 128 KiB, response 64 KiB (configurable down to 1 byte,
up to 1 MiB), HTTP timeout 10 s, DNS timeout 5 s, at most 16 DNS answers. Email:
20 recipients, 32 KiB text, 128 KiB message. Attempts 1 to 8 (default 4), one
backoff delay at most 5 min. Config: 10 channels, 50 hosts, 10 ports.
Dedupe, breaker and dead-letter stores are bounded in memory.

## Security properties

- SSRF: https only, no userinfo, port 443 unless allowlisted, IP literals in any
  spelling refused (even public ones), local-namespace names refused, optional
  per-tenant host allowlist (names only), every DNS answer re-checked, address
  pinned, re-resolved on every attempt, redirects never followed (3xx is a
  permanent failure), response bytes counted and discarded by the transport.
- Slack: `& < >` escaped, scheme URLs defanged, unfurl off, links built only
  from validated URLs.
- Email: narrow address grammar, refuse (never repair), no Cc or Bcc, base64 body.
- Secrets: handles only; resolved per attempt; errors from stores are swallowed;
  audit and results carry fixed codes and the host only.
- Audit: one record per attempt, naming the actor. Fail closed if the audit
  sink is down (before sending, and it stops retries afterward).

## Known gaps

- No real transports. A composition root must supply an HttpTransport that
  honors `PinnedHttpRequest` (connect to `address`, SNI from `hostname`, no
  redirects, body discarded). That contract is tested only through fakes.
- No SMTP implementation; `MailTransport` is an interface.
- Rate limit, dedupe, breaker and dead letters are in memory and per process; a
  multi-instance deployment needs shared stores.
- Slack clients may auto-link bare domains or email addresses in plain text.
- Dead letters hold the validated event (for replay); there is no replay tool.
- IPv6 is allowed only inside 2000::/3 minus reserved ranges; the list of
  special-purpose ranges is static and should be reviewed periodically.
- Wiring into detection findings (items 2.1 to 2.4) is not done here.
- No certification claim is made.
