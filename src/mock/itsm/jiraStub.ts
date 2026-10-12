// Mock Jira server: the wire subset the real JiraAdapter uses.
//   POST /rest/api/2/issue        create (201 { id, key, self })
//   GET  /rest/api/2/issue/{key}  fetch (fields.status.name, fields.updated)
// Bearer auth. Loopback only. Nothing is logged except method, path, status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applyInjectedFailure,
  listenLoopback,
  readBody,
  safeEqual,
  sendJson,
  type JiraIssue,
  type RunningStub,
  type StubOptions,
} from './state';

export interface JiraStubOptions extends StubOptions {
  /** The bearer value the stub accepts. */
  bearer: string;
}

const FAILURE_BODIES = {
  unauthorized: { errorMessages: ['You are not authenticated.'], errors: {} },
  rateLimited: { errorMessages: ['Rate limit exceeded.'], errors: {} },
  serverError: { errorMessages: ['Internal server error.'], errors: {} },
};

const ISSUE_PATH = /^\/rest\/api\/2\/issue(?:\/([^/]+))?$/;

export async function startJiraStub(options: JiraStubOptions): Promise<RunningStub> {
  const expected = `Bearer ${options.bearer}`;
  // The origin is only known after listen; handlers read it lazily.
  let origin = '';

  const stub = await listenLoopback(options, async (req, res, url) => {
    if (await applyInjectedFailure(stub.state, res, FAILURE_BODIES)) return;

    const supplied = req.headers.authorization;
    if (typeof supplied !== 'string' || !safeEqual(supplied, expected)) {
      sendJson(res, 401, FAILURE_BODIES.unauthorized);
      return;
    }

    const match = ISSUE_PATH.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { errorMessages: ['Not found.'], errors: {} });
      return;
    }
    const rawKey = match[1];
    if (req.method === 'POST' && rawKey === undefined) {
      await createIssue(req, res, stub.state, origin);
      return;
    }
    if (req.method === 'GET' && rawKey !== undefined) {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // fall through with the raw segment; it will not match any key
      }
      const issue = stub.state.getJiraIssue(key);
      if (!issue) {
        sendJson(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} });
        return;
      }
      sendJson(res, 200, issueBody(issue, origin));
      return;
    }
    sendJson(res, 405, { errorMessages: ['Method not allowed.'], errors: {} });
  });
  origin = stub.baseUrl;
  return stub;
}

async function createIssue(
  req: IncomingMessage,
  res: ServerResponse,
  state: RunningStub['state'],
  origin: string,
): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const fields = (parsed as { fields?: Record<string, unknown> } | undefined)?.fields;
  const project = (fields?.project as { key?: unknown } | undefined)?.key;
  const summary = fields?.summary;
  if (typeof project !== 'string' || project.length === 0 || typeof summary !== 'string' || summary.length === 0) {
    sendJson(res, 400, { errorMessages: [], errors: { summary: 'summary and project are required' } });
    return;
  }
  const issue = state.createJiraIssue({
    projectKey: project,
    summary,
    description: typeof fields?.description === 'string' ? fields.description : undefined,
  });
  sendJson(res, 201, { id: issue.id, key: issue.key, self: `${origin}/rest/api/2/issue/${issue.id}` });
}

function issueBody(issue: JiraIssue, origin: string) {
  return {
    id: issue.id,
    key: issue.key,
    self: `${origin}/rest/api/2/issue/${issue.id}`,
    fields: {
      summary: issue.summary,
      description: issue.description,
      project: { key: issue.projectKey },
      status: { name: issue.status },
      created: issue.created,
      updated: issue.updated,
    },
  };
}
