// NOT part of any suite (no *.test.ts name). Run only by cli.spawnCleanup.test.ts
// through ./vitest.config.ts: a test that starts a long-running child through
// the test helper's registry and then FAILS mid-way. The helper's afterAll must
// still kill the child; the parent test checks the pid is gone afterwards.
import fs from 'fs';
import { spawn } from 'child_process';
import { expect, it } from 'vitest';
import { trackChild } from '../cli';

it('an assertion fails while a spawned child is still running', () => {
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  fs.writeFileSync(process.env.RATIO_ORPHAN_PID_FILE ?? '', String(child.pid));
  expect('the assertion that fails mid-way').toBe('something else');
});
