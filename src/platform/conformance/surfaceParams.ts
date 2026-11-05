// TEST-ONLY: the known top-level request parameters of each mock surface (ADR-0001 slice C3, review round 5).
// Per public docs, to be verified live: OpenAI API reference (Chat Completions, Responses, legacy Completions) and
// Anthropic API reference (Messages), as read on 2026-11-05. Classes: inert (no tool meaning), content (walked for DLP),
// tools (tool identities extracted), affecting (changes the tools in play without declaring one: an identity is derived,
// else unidentified). Every parameter is walked for DLP whatever its class. Any parameter NOT listed for its surface is
// an unidentified tool (TOOL_UNIDENTIFIED: blocked in enforce, recorded in monitor). Trade-off: a new provider parameter
// is blocked in enforce mode until it is listed here.
export type ParamClass = 'inert' | 'content' | 'tools' | 'affecting';
export const SURFACE_PARAMS: Record<string, Record<ParamClass, string>> = {
  openai_chat: { content: 'messages prediction metadata', tools: 'tools functions', affecting: 'web_search_options',
    inert: 'model audio frequency_penalty function_call logit_bias logprobs max_completion_tokens max_tokens modalities n parallel_tool_calls presence_penalty prompt_cache_key reasoning_effort response_format safety_identifier seed service_tier stop store stream stream_options temperature tool_choice top_logprobs top_p user verbosity' },
  openai_responses: { content: 'input instructions metadata', tools: 'tools', affecting: 'prompt',
    inert: 'model background conversation include max_output_tokens max_tool_calls parallel_tool_calls previous_response_id prompt_cache_key reasoning safety_identifier service_tier store stream stream_options temperature text tool_choice top_logprobs top_p truncation user' },
  anthropic_messages: { content: 'messages system metadata', tools: 'tools mcp_servers', affecting: 'container',
    inert: 'model max_tokens context_management service_tier stop_sequences stream temperature thinking tool_choice top_k top_p' },
  openai_completions: { content: 'prompt suffix', tools: '', affecting: '',
    inert: 'model best_of echo frequency_penalty logit_bias logprobs max_tokens n presence_penalty seed stop stream stream_options temperature top_p user' },
};
/** The class of a top-level parameter on a surface; undefined when it is not listed. */
export const paramClass = (dest: string, k: string): ParamClass | undefined =>
  (Object.entries(SURFACE_PARAMS[dest] ?? {}) as [ParamClass, string][]).find(([, names]) => names.split(' ').filter(Boolean).includes(k))?.[0];
