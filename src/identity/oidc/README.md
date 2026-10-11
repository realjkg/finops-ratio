# OIDC identity (checklist Step 1, items 1.1 to 1.5)

A provider-neutral JWT verifier that implements `TokenVerifier` and maps a
provider's signed token onto the gateway `Principal` with
`authMethod: 'oidc'`. It is the class that replaces the mock verifier when an
identity provider is chosen (sprint plan D1). Issuer, audience, key-set
location and claim names are configuration; nothing is hard-coded to one
provider.

Trust boundary: the bearer string and the provider's key-set document. Both
are untrusted until verified. Every failure is an `OidcError` with a code from
a closed union and fixed text that never echoes a token, claim, key id or URL.
Deny by default throughout.

## Public API (`index.ts`)

| Export | Purpose |
|---|---|
| `OidcVerifier` | `new OidcVerifier(config, { fetchJwks, isRevoked, clock?, createSignal? })`; `verify(bearer, { now, deployEnv })` returns a frozen `Principal` or throws `OidcError`. |
| `resolveOidcConfig` | Strict config parse (unknown fields refused). Also run by the constructor. |
| `JwksCache`, `parseJwks` | The key-set cache and document parser, exported for composition and tests. |
| `createMemoryJtiDenylist` | Bounded in-memory reference for the `isRevoked` hook. |
| `OidcError`, `OIDC_ERROR_CODES`, `oidcErrorMessage` | Error type (cross-bundle `instanceof`, same brand approach as `MockIdpError`). |
| `DEFAULT_ROLE_PRECEDENCE`, `OIDC_ALGS`, limit constants | Documented defaults and ceilings. |

`testkit.ts` (key generation, token forging, fake key-set server) is test
support only and is not exported.

## Check order

Context (`now`, `deployEnv`), type and size, three canonical base64url
segments, header (injection members `jku`, `x5u`, `x5c`, `jwk`, `crit` refused;
unknown members refused; `alg` must be in the allowlist, so `none` and HS*
never reach a key; `kid` required), key lookup through the cache, algorithm
agreement between header and key, signature, strict claims, issuer (exact),
audience (string, or array containing the configured value; `azp` required when the array has several entries, and whenever present it must equal `authorizedParty`, default the audience), `exp`/`nbf`/`iat`
with bounded skew, lifetime cap, role/tenant/teams/envs mapping, then the
revocation hook last. The payload is not parsed as JSON until the signature
verifies. The key, not the header, fixes the algorithm.

## Claim mapping

Required claims: `iss sub aud exp iat jti` plus the four configured names for
groups, tenant, teams and envs. Any other claim is refused unless it is in
`STANDARD_IGNORED_CLAIMS` or `extraIgnoredClaims`; ignored claims are never
copied into the Principal. `cnf`, `nonce`, `at_hash` and `c_hash` are not
tolerated (no proof-of-possession tokens, no ID tokens as bearers).

Role: groups map to roles through `groupToRole`. Unmapped groups are ignored;
if none maps, the token is denied (`no_role`). When several map to different
roles the winner is the role listed earliest in `rolePrecedence`, whatever the
order of the groups claim. The default is narrowest first (least privilege):
`auditor, procurement, finance, eng_lead, finops_lead, cto`. `legacy_service`
can never be produced.

Subject: must be a stable id (`[A-Za-z0-9._:|-]`, 1 to 128). An email-shaped
`sub` is refused unless `rejectEmailSub: false`.

Tenant must be in `allowedTenants` (`wrong_tenant` otherwise). Teams are a
strict list (no `*` anywhere inside, no padding, no duplicates), or `'*'` as the
whole value only when `allowOrgWide` is true; an `eng_lead` can never be
org-wide. Envs must be a list of `dev|test|prod` and must include the
deployment's own `deployEnv` (`wrong_environment`), because `aud` is not
per-environment.

## Caps

| Item | Limit |
|---|---|
| Token length | default 8192, configurable 256 to 16384 |
| Header segment / signature segment | 2048 / 1400 characters |
| Clock skew | 0 to 120 s (default 30) |
| Lifetime (`exp - iat`) | configured, 1 to 86400 s |
| `aud` array / groups / teams / envs | 16 / 256 / 64 / 3 entries |
| Group map / allowed tenants / extra ignored claims | 256 / 64 / 64 |
| Key set TTL / cooldown / stale-if-error | 30 to 86400 s (600) / 1 s to TTL (30) / 0 to 86400 s (3600) |
| Key set keys / bytes / fetch deadline | 1 to 64 (16) / 1 KiB to 256 KiB (64 KiB) / 100 to 30000 ms (5000) |
| RSA modulus / exponent | 2048 to 8192 bits, odd / odd, at least 65537 |
| Denylist entries | 1 to 100000, refuses when full (never evicts a live entry) |

## JWKS cache behavior

Fresh for the TTL. An unknown `kid` triggers one forced refresh, and at most
one network attempt happens per cooldown window, so random kids cannot cause
fetch amplification. Concurrent misses share one in-flight fetch. If a refresh
fails, the previous set keeps serving known kids until `ttl + staleIfError`
(hard ceiling), then every lookup fails closed (`jwks_unavailable`). A document
with a duplicate kid, bad JSON, no usable key, or over the byte or key bound is
refused whole and the previous set stays. Keys with `use` other than `sig`,
`key_ops` lacking `verify`, a conflicting `alg`, private members, weak RSA, or
a non-P-256 curve are skipped. A backwards clock step counts as expired.

## Known gaps (not built, do not assume)

- No live identity provider was exercised. Tests use generated keys and a fake
  key-set server only; real provider token shapes are untested.
- `fetchJwks` is an injected seam. This slice has no network code and no SSRF or
  egress guard; the production fetcher must enforce https-only targets, the
  byte bound, redirect policy and DNS rules (egress is a restricted class).
- Not wired into `authenticate()` or `withGateway` (card B1, outside this
  directory). No audit record is written here; the gateway must record the
  acting `sub` and the denial code.
- All four claims (groups, tenant, teams, envs) are required. A provider that
  cannot emit them needs a claims-mapping rule on its side. Groups delivered by
  overage reference or userinfo lookup are not supported.
- The in-memory denylist is single process. A multi-instance deployment needs a
  shared store behind `isRevoked`. The hook has no built-in deadline; a hook
  that fails or answers anything but a boolean denies the token.
- Bearer replay inside a token's lifetime is allowed by default; single-use
  behavior needs a hook that records ids on first sight.
- A retired signing key stays acceptable until the next refresh (up to the TTL,
  or the stale ceiling during an outage). A legitimately rotated-in key can be
  refused for up to one cooldown after a recent fetch.
- `typ` is optional (`JWT` or `at+jwt`); RFC 9068 access-token typing is not
  required. No DPoP or mTLS binding.
- The cache is per process; there is no shared key-set cache.
