import { expect, it } from 'vitest';
import { nextTask, overallStatus, implementationPrompt } from './core.mjs';
const plan = { tasks: [{ id: 'foundation', kind: 'automated', gates: ['unit', 'browser'], instruction: 'Implement the missing workflow.' }, { id: 'auth', kind: 'external', requires: 'Dev accounts' }] };
it('does not equate a passing simulation with completion', () => {
  const gates = { unit: { status: 'passed' }, browser: { status: 'passed' } };
  expect(nextTask(plan, gates).id).toBe('auth'); expect(overallStatus(plan, gates)).toBe('blocked');
});
it('keeps failed, missing and blocked gates open', () => {
  for (const status of ['failed', 'blocked', undefined]) expect(nextTask(plan, { unit: { status: 'passed' }, browser: { status } }).id).toBe('foundation');
});
it('scopes implementation to local work and preserves approval gates', () => {
  expect(implementationPrompt(plan.tasks[0], {})).toMatch(/Make and verify code changes/);
  expect(implementationPrompt(plan.tasks[0], {})).toMatch(/Do not publish/);
});
