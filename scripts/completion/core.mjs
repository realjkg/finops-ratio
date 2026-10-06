import { createHash } from 'node:crypto';
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function nextTask(plan, gates) {
  return plan.tasks.find(task => task.kind === 'external' || task.gates.some(id => gates[id]?.status !== 'passed')) ?? null;
}
export function overallStatus(plan, gates) {
  const next = nextTask(plan, gates);
  return !next ? 'complete' : next.kind === 'external' ? 'blocked' : 'incomplete';
}
export function implementationPrompt(task, report) {
  return `Implement the next Ratio task: ${task.title}\n${task.instruction}\n\nRead AGENTS.md and current source first. Make and verify code changes; do not return prose alone. Work only in this local repository. Do not publish, push, deploy, merge, send messages, access personal accounts, weaken gates, or bypass approval controls. Stop if credentials, authorization or an unavailable service is required. Do not alter the completion plan or runner to manufacture a pass.\n\nVerification evidence:\n${JSON.stringify(report, null, 2)}`;
}
