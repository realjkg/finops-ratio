// Owner's validate step for #152 (ReDoS): every hostile AWS location value is validated in a CHILD process
// with a hard kill timeout per case, so a regression in the length-first guard or a backtracking pattern
// FAILS this test instead of blocking the vitest event loop. Startup (checkEngagementConfig) and worker
// (engagementProblems), all three fields, 1 MiB quadratic shapes, NFKC-expanding values and values at the caps.
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import readline from 'readline';
import { describe, expect, it } from 'vitest';
import { SHAPES } from './testing/hostileChild';

const HARD_KILL_MS = 2000;
const MiB = 1024 * 1024;
const CAPS: Record<string, number> = { bucket: 63, exportName: 128, prefix: 1024 };
const ROOT = path.resolve(__dirname, '../../..');

type Answer = { ms: number; refused: boolean; echoed: boolean };

/** A fresh child per test: answers one JSON line per case; a case that is not answered in time kills it. */
async function startChild(): Promise<{ check: (spec: { side: 'startup' | 'worker'; field: string; shape: string; n: number }) => Promise<Answer>; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'testing/hostileChild.ts')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending: Array<(line: string) => void> = [];
  readline.createInterface({ input: child.stdout! }).on('line', (l) => pending.shift()?.(l));
  child.stdin!.on('error', () => undefined); // a killed child closes the pipe; the watchdog error below is what the test reports
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child did not start')), 30_000);
    pending.push((l) => (clearTimeout(t), l === 'READY' ? resolve() : reject(new Error(l))));
  });
  const check = (spec: { side: 'startup' | 'worker'; field: string; shape: string; n: number }) =>
    new Promise<Answer>((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`watchdog: ${spec.side} ${spec.field} ${spec.shape} x${spec.n} did not finish within ${HARD_KILL_MS} ms (child killed)`));
      }, HARD_KILL_MS);
      pending.push((l) => (clearTimeout(t), resolve(JSON.parse(l) as Answer)));
      child.stdin!.write(`${JSON.stringify(spec)}\n`);
    });
  return { check, stop: () => void (child.exitCode === null && child.kill('SIGKILL')) };
}

describe('hostile AWS location values under an external watchdog', () => {
  for (const side of ['startup', 'worker'] as const) {
    for (const field of ['bucket', 'prefix', 'exportName']) {
      it(`${side}: ${field}: 1 MiB values are refused and at-cap values finish, each within ${HARD_KILL_MS} ms`, async () => {
        const { check, stop } = await startChild();
        try {
          for (const shape of Object.keys(SHAPES)) {
            const big = await check({ side, field, shape, n: MiB });
            expect(big.refused, `${shape} 1 MiB`).toBe(true);
            expect(big.echoed, `${shape} 1 MiB echo`).toBe(false);
            expect(big.ms, `${shape} 1 MiB (measured in the child)`).toBeLessThan(100);
            const atCap = await check({ side, field, shape, n: CAPS[field] });
            expect(atCap.echoed, `${shape} at cap echo`).toBe(false);
            expect(atCap.ms, `${shape} at cap`).toBeLessThan(100);
          }
        } finally {
          stop();
        }
      }, 60_000);
    }
  }
});
