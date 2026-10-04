// NOT part of any suite (no *.test.ts name). Run only by cli.spawnCleanup.test.ts
// through ./vitest.config.ts: a test that starts a long-running child through
// the test helper's registry and then FAILS mid-way (or, with
// RATIO_ORPHAN_HANG=1, hangs so the parent can interrupt the whole nested run).
// The helper's afterAll must kill the child on failure; the parent kills by
// process group and by env marker when the run itself is interrupted.
//
// Leak bounds: the pid is written BEFORE anything else can fail, and the child
// exits by itself after 120 s even if every cleanup were missed.
import fs from 'fs';
import { spawn } from 'child_process';
import { expect, it } from 'vitest';
import { trackChild } from '../cli';

const CHILD_SCRIPT = 'setTimeout(() => process.exit(0), 120000); setInterval(() => {}, 1000);';

it(
  'an assertion fails (or the run hangs) while a spawned child is still running',
  async () => {
    // Inherits RATIO_ORPHAN_MARKER from the environment: the parent finds strays by it.
    const raw = spawn(process.execPath, ['-e', CHILD_SCRIPT], { stdio: 'ignore' });
    fs.writeFileSync(process.env.RATIO_ORPHAN_PID_FILE ?? '', String(raw.pid));
    trackChild(raw);
    if (process.env.RATIO_ORPHAN_HANG === '1') await new Promise(() => undefined); // interrupted from outside
    expect('the assertion that fails mid-way').toBe('something else');
  },
  60_000,
);
