// Preloaded (node --import tsx --import <this>) by the crash-handler
// write-path test in cli.worker.test.ts. Replaces the ASYNC stream writes with
// a marker written synchronously, so a fatal path that uses
// process.stderr.write (or process.stdout.write) instead of the synchronous
// writeAllSync(2, …) shows up as the marker instead of the JSON line.
import fs from 'fs';

for (const [name, stream] of [
  ['STDERR', process.stderr],
  ['STDOUT', process.stdout],
] as const) {
  (stream as { write: (...args: unknown[]) => boolean }).write = () => {
    fs.writeSync(2, `ASYNC_${name}_WRITE_USED\n`);
    return true;
  };
}
