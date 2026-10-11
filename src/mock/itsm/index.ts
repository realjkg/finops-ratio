// RED skeleton: every export throws until the implementation lands.
const notImplemented = (): never => {
  throw new Error('not implemented');
};
export const createItsmState = notImplemented as unknown as (o?: unknown) => any;
export const startJiraStub = notImplemented as unknown as (o: any) => Promise<any>;
export const startServiceNowStub = notImplemented as unknown as (o: any) => Promise<any>;
export const startMockItsm = notImplemented as unknown as (o: any) => Promise<any>;
export type RunningStub = any;
