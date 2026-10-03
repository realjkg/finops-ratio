// Child process for the spawned crash-handler test (cli.worker.test.ts, run
// with tsx). Wires the CLI's process handlers exactly as the CLI entry does
// (real process, stderr, process.exit), then crashes with an Error whose
// message is RATIO_CRASH_BYTES long and full of the configured secrets.
// RATIO_CRASH_MODE=baseline exits 0 right after start-up (timing reference).
import { installProcessHandlers, type CliIO } from '../cli';

const io: CliIO = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') };
installProcessHandlers(process, process.env, io, (code) => process.exit(code));

if (process.env.RATIO_CRASH_MODE === 'baseline') process.exit(0);

const secret = process.env.RATIO_CRASH_SECRET ?? '';
const size = Number(process.env.RATIO_CRASH_BYTES ?? '0');
// Secrets in every form, URL/quote/backslash/percent fragments and a long run of
// scheme-like letters (the shape that made the old redactor quadratic).
const unit = `boom ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret).slice(1, -1)} a://a:// "\\" %22 ${secret.slice(0, 4)} ${'a'.repeat(40_000)} `;
const message = unit.repeat(Math.ceil(size / unit.length));
const mode = process.env.RATIO_CRASH_MODE ?? 'throw';
setImmediate(() => {
  if (mode === 'reject') void Promise.reject(Object.assign(new Error(message), { code: 'XX000', detail: message }));
  else throw Object.assign(new Error(message), { code: 'XX000', detail: message });
});
