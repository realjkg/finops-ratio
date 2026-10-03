// Child process for the spawned crash-handler test (cli.worker.test.ts, run
// with tsx). Wires the CLI's process handlers exactly as the CLI entry does
// (real process, stderr, process.exit), then crashes with an Error whose
// message is RATIO_CRASH_BYTES long and full of the configured secrets.
//
// Timing is measured HERE, not as spawn wall time (which includes tsx start-up
// and is noisy under load): from just before the crash is raised to the moment
// the handler's line is written, reported as JSON on fd 3 when the parent
// opened it.
import fs from 'fs';
import { installProcessHandlers, type CliIO } from '../cli';

let raisedAt = 0;
const io: CliIO = {
  out: (l) => fs.writeSync(1, l + '\n'),
  err: (l) => {
    fs.writeSync(2, l + '\n');
    try {
      fs.writeSync(3, JSON.stringify({ handlerMs: performance.now() - raisedAt }) + '\n');
    } catch {
      // fd 3 not open: no timing report
    }
  },
};
installProcessHandlers(process, process.env, io, (code) => process.exit(code));

const secret = process.env.RATIO_CRASH_SECRET ?? '';
const size = Number(process.env.RATIO_CRASH_BYTES ?? '0');
// Secrets in every form, URL/quote/backslash/percent fragments and a long run of
// scheme-like letters (the shape that made the old redactor quadratic).
const unit = `boom ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret).slice(1, -1)} a://a:// "\\" %22 ${secret.slice(0, 4)} ${'a'.repeat(40_000)} `;
const message = unit.repeat(Math.ceil(size / unit.length));
const mode = process.env.RATIO_CRASH_MODE ?? 'throw';
setImmediate(() => {
  raisedAt = performance.now();
  if (mode === 'reject') void Promise.reject(Object.assign(new Error(message), { code: 'XX000', detail: message }));
  else throw Object.assign(new Error(message), { code: 'XX000', detail: message });
});
