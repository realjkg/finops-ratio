// Mock ITSM servers (Jira and ServiceNow). Loopback only; local and ephemeral.

import { startJiraStub, type JiraStubOptions } from './jiraStub';
import { startServiceNowStub, type ServiceNowStubOptions } from './serviceNowStub';
import { createItsmState, type ItsmState, type RunningStub } from './state';

export { startJiraStub, type JiraStubOptions } from './jiraStub';
export { startServiceNowStub, type ServiceNowStubOptions } from './serviceNowStub';
export {
  createItsmState,
  isLoopbackHost,
  JIRA_INITIAL_STATUS,
  LOOPBACK_HOST,
  SERVICENOW_INITIAL_STATE,
  type FailureKind,
  type FailureRule,
  type ItsmState,
  type JiraIssue,
  type RequestLogEntry,
  type RunningStub,
  type ServiceNowChange,
  type StubOptions,
} from './state';

export interface MockItsm {
  state: ItsmState;
  jira: RunningStub;
  serviceNow: RunningStub;
  close(): Promise<void>;
}

/** Start both stubs on free loopback ports over one shared state. */
export async function startMockItsm(options: {
  jira: Omit<JiraStubOptions, 'state'>;
  serviceNow: Omit<ServiceNowStubOptions, 'state'>;
}): Promise<MockItsm> {
  const state = createItsmState();
  const jira = await startJiraStub({ ...options.jira, state });
  let serviceNow: RunningStub;
  try {
    serviceNow = await startServiceNowStub({ ...options.serviceNow, state });
  } catch (err) {
    await jira.close();
    throw err;
  }
  return {
    state,
    jira,
    serviceNow,
    close: async () => {
      await Promise.all([jira.close(), serviceNow.close()]);
    },
  };
}
