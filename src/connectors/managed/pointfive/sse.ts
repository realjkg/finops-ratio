// Incremental SSE decoder (WHATWG event-stream rules: CRLF/LF/CR line ends, data
// lines joined with "\n", blank line dispatches, ":" comments, an unterminated
// trailing event is discarded). Lines are bounded against hostile streams.

import { McpProtocolError } from './errors';

export interface SseEvent { event: string; data: string }

export class SseDecoder {
  private buf = '';
  private data: string[] = [];
  private event = '';

  constructor(private readonly maxLineChars: number) {}

  /** True when an event or a line has started but not been dispatched. */
  get pending(): boolean {
    return this.buf.length > 0 || this.data.length > 0 || this.event !== '';
  }

  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (!m || (m[0] === '\r' && m.index === this.buf.length - 1)) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line, out);
    }
    if (this.buf.length > this.maxLineChars) {
      throw new McpProtocolError('RESPONSE_TOO_LARGE', 'PointFive MCP SSE line exceeds the size bound');
    }
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    // `id` and `retry` are accepted and unused: this client does not resume streams.
  }
}
