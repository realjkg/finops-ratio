// Test-only child (stageFile.test.ts "bounded memory"): runs the real staging path of `import-file`
// (read, decode, stage; no database, no S3) on one local file and prints its byte count and the
// process's peak RSS as one JSON line. Run with a constrained heap: node --max-old-space-size=N.
import { stageLocalFiles } from '../import/importFile';

const file = process.argv[2];
void Promise.resolve(stageLocalFiles([file], { location: { bucket: 'ratio-mem-test', prefix: 'mem', exportName: 'mem' }, providers: ['AWS'] })).then((staged) => {
  const bytes = staged.files.reduce((n, f) => n + f.bytes, 0);
  process.stdout.write(`${JSON.stringify({ bytes, periods: staged.periods.length, maxRssBytes: process.resourceUsage().maxRSS * 1024 })}\n`);
});
