// LiveCMClient — browser-safe gateway client that proxies to /api/v1/cm/change.
// No credentials cross the wire from the browser; JIRA_* and SERVICENOW_* keys
// are read exclusively in the API route. Mirrors LiveAIClient error handling.

import type {
  CMClient,
  CMFindingInput,
  CMTicketResult,
  CMReferenceRecord,
  CMStatusResult,
  CMAttachInput,
} from './CMClient';
import { withBasePath } from '@/lib/basePath';

const CM_URL = withBasePath('/api/v1/cm/change');

export class LiveCMClient implements CMClient {
  readonly mode = 'live' as const;

  async createChange(finding: CMFindingInput, action: string): Promise<CMTicketResult> {
    return this.post<CMTicketResult>({ operation: 'create', finding, action });
  }

  async attachReference(input: CMAttachInput): Promise<CMReferenceRecord> {
    return this.post<CMReferenceRecord>({ operation: 'attach', ...input });
  }

  async getStatus(ticketRef: string): Promise<CMStatusResult> {
    return this.post<CMStatusResult>({ operation: 'status', ticketRef });
  }

  private async post<T>(body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(CM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `CM gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`CM gateway error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

