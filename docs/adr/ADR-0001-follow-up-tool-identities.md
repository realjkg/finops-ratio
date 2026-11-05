# ADR-0001 follow-up: tool identities and inspection limits (Stream C)

Status: follow-up note for the orchestrator, not a decision record. Source: challenger review round 4 of #184 (slice C3). The mock gateway in `src/platform/conformance/` is the test-only reference for this convention. Ratio is not a production gateway; a production integration (slice C6) has to implement the same convention.

## Tool identities, for bundle authors

A gateway names every tool in a request context with a namespaced identity. A `tool` condition in a policy matches these ids exactly.

| Identity | Source |
|---|---|
| `fn:<name>` | Function tools (type `function` or none) and function calls in history, once for each name given (`function.name` and `name`). |
| `mcp:<label>` | `mcp` tools and Responses `mcp_call` items (`server_label`), Messages `mcp_tool_use` blocks (`server_name`), Anthropic `mcp_servers` entries (`name`). |
| `type:<type>` | Other typed tools, by their `type`; a `name` on a typed tool is never an identity. A Messages `server_tool_use` block is `type:<name>`. |
| `<kind>-h:<16 hex>` | A name that is not an identifier even with its prefix (the first 16 hex digits of its SHA-256). |
| `unidentified:<requestRef>` | A tool with no identity, or a top-level parameter that may declare tools and is not known to the gateway (for example `plugins`). |

Rules:

- **Bare names never match.** `tool in ['shell']` does not deny `fn:shell`. `unnamespacedTools(compiled)` in `src/platform/policy/` lists the ids of a bundle that have no namespace (advisory, never gating).
- **Unidentified tools cannot be listed or allowed.** A bundle whose tool conditions name an `unidentified:` id is refused (`BUNDLE_INVALID`). The access decision refuses a request that carries an unidentified tool (`TOOL_UNIDENTIFIED`): blocked in enforce mode, recorded in monitor mode.
- An allowlist (`not_in`) passes only when every identity of the request is listed; a denylist (`in`) matches when any one is.
- A server tool appears twice: declared as `type:web_search_20250305`, called in history as `type:web_search`. List both.
- `tool_choice` is only partly an identity source: the chat form `{type: 'function', function: {name}}` is collected as `fn:<name>`; other forms (for example `{type: 'mcp', server_label}`) are not. A choice of an undeclared tool is left to the provider.

## Availability cost of uninspectable blocks (note for C6)

At content-block positions, a block the text detectors cannot read is uninspectable, so DLP is unavailable and DLP policies fail closed. This is accepted for now. Examples: Messages `redacted_thinking`, `web_search_tool_result` and `mcp_tool_result` blocks in history; Responses `reasoning` and `item_reference` input items; media and file parts. A conversation that carries one is blocked by DLP policies in enforce mode. C6 should decide per deployment whether to strip, resolve or exempt them.

## Runtime requirement

Exact numbers need `JSON.parse` source-text access (Node 21 or later; `package.json` requires Node 22.13 or later). The mock gateway checks for it when it is created and throws when it is missing. There is no fallback.
