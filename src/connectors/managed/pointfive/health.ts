// Four-stage PointFive health probe. Each stage is reported separately and a
// later stage runs only when the stages it depends on passed:
//   auth    - an access token was obtained from the OAuth client
//   session - MCP initialize succeeded and the server declared `tools`
//   tools   - tools/list contains every configured tool, schema-compatible
//   data    - one bounded read call on the findings tool returned a list in
//             which every item passed the adapter's validator
// Only all four passing is "source-access-verified". Details are fixed text
// (error codes and capability names), never tokens, secrets or payload values.

import { redactErrorText } from '../../../costsource/transports/redact';
import { McpProtocolError } from './errors';
import { DiscoveredTools, extractItems, type ToolMapping } from './discovery';
import type { McpClient, TokenProvider } from './mcpClient';

export type VerificationState =
  | 'not-configured'
  | 'configured-not-verified' // configured, but no token
  | 'auth-verified' // token obtained; no MCP session
  | 'degraded' // session established; tools or data failed
  | 'source-access-verified'; // all four stages passed

export type StageName = 'auth' | 'session' | 'tools' | 'data';
/** `ok: null` means the stage did not run because an earlier one failed. */
export interface StageResult { ok: boolean | null; code?: string; detail: string }

export interface PointFiveHealthReport {
  state: VerificationState;
  stages: Record<StageName, StageResult>;
  session?: { protocolVersion: string; serverName: string };
}

const SKIPPED: StageResult = { ok: null, detail: 'not run' };
const failed = (err: unknown): StageResult => ({
  ok: false,
  code: err instanceof McpProtocolError ? err.code : 'ERROR',
  detail: err instanceof McpProtocolError ? err.message : redactErrorText(err),
});

export async function probePointFive(deps: {
  tokenProvider: TokenProvider;
  client: McpClient;
  mapping: ToolMapping;
  validateDataItem: (item: unknown) => unknown;
}): Promise<PointFiveHealthReport> {
  const stages: Record<StageName, StageResult> = { auth: SKIPPED, session: SKIPPED, tools: SKIPPED, data: SKIPPED };
  const report = (state: VerificationState, extra: Partial<PointFiveHealthReport> = {}) => ({ state, stages, ...extra });
  try {
    await deps.tokenProvider.getAccessToken();
    stages.auth = { ok: true, detail: 'access token obtained' };
  } catch {
    // Fixed text: a token-endpoint failure may carry credential material.
    stages.auth = { ok: false, code: 'TOKEN_UNAVAILABLE', detail: 'access token not obtained' };
    return report('configured-not-verified');
  }
  let session;
  try {
    const s = await deps.client.initialize();
    if (typeof s.capabilities.tools !== 'object' || s.capabilities.tools === null) {
      throw new McpProtocolError('MALFORMED_RESPONSE', 'PointFive MCP server did not declare the tools capability');
    }
    session = { protocolVersion: s.protocolVersion, serverName: s.serverInfo.name };
    stages.session = { ok: true, detail: `initialized, protocol ${s.protocolVersion}` };
  } catch (err) {
    stages.session = failed(err);
    return report('auth-verified');
  }
  let tools: DiscoveredTools;
  try {
    tools = new DiscoveredTools(await deps.client.listTools(), deps.mapping);
    const missing = tools.missing();
    stages.tools = missing.length === 0
      ? { ok: true, detail: 'all configured tools discovered' }
      : { ok: false, code: 'TOOL_NOT_DISCOVERED', detail: `configured tools not discovered: ${missing.join(', ')}` };
  } catch (err) {
    stages.tools = failed(err);
    return report('degraded', { session });
  }
  try {
    const tool = tools.require('opportunities', {});
    const list = extractItems('opportunities', await deps.client.callTool(tool.name, {}));
    list.forEach((item) => deps.validateDataItem(item));
    stages.data = { ok: true, detail: `findings read returned ${list.length} valid item(s)` };
  } catch (err) {
    // Item validator messages name the field, never its value.
    stages.data = failed(err);
  }
  const all = Object.values(stages).every((s) => s.ok === true);
  return report(all ? 'source-access-verified' : 'degraded', { session });
}
