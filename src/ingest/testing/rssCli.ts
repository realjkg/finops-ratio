// Test-only child (importFile.db.test.ts "B2"): runs the worker CLI in this process, prints its
// evidence record on stdout and, on stderr, one line `RSS {"code":N,"maxRssBytes":M}` with the
// process's peak RSS. Run with a constrained heap: node --max-old-space-size=N --import tsx.
import { main } from '../cli';

main(process.argv.slice(2), process.env, { out: (l) => process.stdout.write(`${l}\n`), err: () => undefined }).then((code) => {
  process.stderr.write(`RSS ${JSON.stringify({ code, maxRssBytes: process.resourceUsage().maxRSS * 1024 })}\n`);
  process.exit(code);
});
