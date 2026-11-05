# ADR-0001 follow-up: tool identities and inspection limits (Stream C)

Status: follow-up note for the orchestrator, not a decision record. Source: challenger review rounds 4 and 5 of #184 (slice C3). The mock gateway in `src/platform/conformance/` is the test-only reference for this convention. Ratio is not a production gateway; a production integration (slice C6) has to implement the same convention.

## Tool identities, for bundle authors

A gateway names every tool in a request context with a namespaced identity. A `tool` condition in a policy matches these ids exactly.

| Identity | Source |
|---|---|
| `fn:<name>` | Function tools (type `function`, `custom` or none) and function or custom tool calls in history (`function_call`, `custom_tool_call`, `tool_use`), once for each name given (`function.name` and `name`). |
| `mcp:<label>` | `mcp` tools and Responses `mcp_call`, `mcp_list_tools` and `mcp_approval_request` items (`server_label`), Messages `mcp_tool_use` blocks (`server_name`), Anthropic `mcp_servers` entries (`name`). The tools an `mcp_list_tools` item lists are the server's, not function identities. |
| `type:<type>` | Other typed tools, by their `type`; a `name` on a typed tool is never an identity. A Messages `server_tool_use` block is `type:<name>`. Chat `web_search_options` is `type:web_search`. |
| `container:<id>`, `skill:<skill_id>` | The Messages `container` parameter: its id (a string, or `id`) and each of its `skills`. |
| `prompt:<id>` | The Responses stored `prompt` parameter (`id`). |
| `<kind>-h:<16 hex>` | A name that is not an identifier even with its prefix (the first 16 hex digits of its SHA-256). |
| `unidentified:<requestRef>` | A tool with no identity, a tool-affecting parameter that names nothing (for example `container: {}`), or any top-level parameter that is not listed for its surface (below). |

Rules:

- **Bare names never match.** `tool in ['shell']` does not deny `fn:shell`. `unnamespacedTools(compiled)` in `src/platform/policy/` lists the ids of a bundle that have none of the namespaces above (advisory, never gating).
- **Unidentified tools cannot be listed or allowed.** A bundle whose tool conditions name an `unidentified:` id is refused (`BUNDLE_INVALID`). The access decision refuses a request that carries an unidentified tool (`TOOL_UNIDENTIFIED`): blocked in enforce mode, recorded in monitor mode.
- An allowlist (`not_in`) passes only when every identity of the request is listed; a denylist (`in`) matches when any one is.
- A server tool appears twice: declared as `type:web_search_20250305`, called in history as `type:web_search`. List both.
- `tool_choice` is only partly an identity source: the chat form `{type: 'function', function: {name}}` is collected as `fn:<name>`; other forms (for example `{type: 'mcp', server_label}`) are not. A choice of an undeclared tool is left to the provider.

## Top-level parameters: list-based detection

Detection is **list-based** (orchestrator decision, round 5): `src/platform/conformance/surfaceParams.ts` lists the known top-level request parameters of each mock surface. The lists follow the public docs (OpenAI API reference for Chat Completions, Responses and legacy Completions; Anthropic API reference for Messages) as read on 2026-11-05, **to be verified live**. Every parameter is walked for DLP whatever its class. A parameter with a `null` value declares nothing.

| Surface | content | tools | affecting | inert |
|---|---|---|---|---|
| Chat Completions | `messages`, `prediction`, `metadata` | `tools`, `functions` | `web_search_options` | `model`, `audio`, `frequency_penalty`, `function_call`, `logit_bias`, `logprobs`, `max_completion_tokens`, `max_tokens`, `modalities`, `n`, `parallel_tool_calls`, `presence_penalty`, `prompt_cache_key`, `reasoning_effort`, `response_format`, `safety_identifier`, `seed`, `service_tier`, `stop`, `store`, `stream`, `stream_options`, `temperature`, `tool_choice`, `top_logprobs`, `top_p`, `user`, `verbosity` |
| Responses | `input`, `instructions`, `metadata` | `tools` | `prompt` | `model`, `background`, `conversation`, `include`, `max_output_tokens`, `max_tool_calls`, `parallel_tool_calls`, `previous_response_id`, `prompt_cache_key`, `reasoning`, `safety_identifier`, `service_tier`, `store`, `stream`, `stream_options`, `temperature`, `text`, `tool_choice`, `top_logprobs`, `top_p`, `truncation`, `user` |
| Messages | `messages`, `system`, `metadata` | `tools`, `mcp_servers` | `container` | `model`, `max_tokens`, `context_management`, `service_tier`, `stop_sequences`, `stream`, `temperature`, `thinking`, `tool_choice`, `top_k`, `top_p` |
| legacy Completions | `prompt`, `suffix` | — | — | `model`, `best_of`, `echo`, `frequency_penalty`, `logit_bias`, `logprobs`, `max_tokens`, `n`, `presence_penalty`, `seed`, `stop`, `stream`, `stream_options`, `temperature`, `top_p`, `user` |

**Any parameter not listed for its surface is unidentified** (for example `extensions`, `skills` at the top level, `capabilities`, `actions`, `extra_body`, or `tools` on legacy Completions). **Trade-off:** a new provider parameter is blocked in enforce mode, and recorded in monitor mode, until it is listed. A production integration should keep these lists per provider version and review them with each provider release.

## Availability cost of uninspectable blocks (note for C6)

At content-block positions, a block the text detectors cannot read is uninspectable, so DLP is unavailable and DLP policies fail closed. This is accepted for now. Examples: Messages `redacted_thinking`, `web_search_tool_result` and `mcp_tool_result` blocks in history; Responses `reasoning`, `item_reference`, `mcp_approval_request` and `mcp_approval_response` input items; media and file parts. A conversation that carries one is blocked by DLP policies in enforce mode. C6 should decide per deployment whether to strip, resolve or exempt them.

## Runtime requirement

Exact numbers need `JSON.parse` source-text access (Node 21 or later; `package.json` requires Node 22.13 or later). The mock gateway checks for it when it is created and throws when it is missing. There is no fallback.
