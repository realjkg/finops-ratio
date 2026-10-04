#!/usr/bin/env node
// Pinned fetch of the FOCUS 1.0 Sample Data files that are NOT committed
// (today: the 10,000-row file) for `npm run local:acceptance -- --dataset 10k`.
//
//   npm run sample:fetch                         download from the pinned commit
//   npm run sample:fetch -- --from-clone <dir>   copy from a local clone of
//                                                focus-sample-data instead
//
// The URL, size and SHA-256 come only from fixtures/focus-1.0-sample/dataset.json.
// Each file is written (temp file + rename, into the gitignored
// .ratio-sample-data/<commit>/) only after its size and SHA-256 are verified.
// The download has a hard deadline. This is the ONLY network use of the
// acceptance tooling, and it never runs implicitly.
//
// Data: "FOCUS 1.0 Sample Data", FinOps Foundation, CC BY 4.0. See
// fixtures/focus-1.0-sample/NOTICE.md.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { copyPinnedFile, fetchPinnedFile, pinnedUrl, readDataset } from '../local/acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The whole download of one file (7.5 MB for the 10k file). */
const FETCH_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  if (argv.length === 0) return { fromClone: null };
  if (argv.length === 2 && argv[0] === '--from-clone' && argv[1]) return { fromClone: path.resolve(argv[1]) };
  throw new Error('usage: npm run sample:fetch [-- --from-clone <dir>]');
}

async function main(argv) {
  const { fromClone } = parseArgs(argv);
  const ds = readDataset(ROOT);
  for (const [key, pin] of Object.entries(ds.files)) {
    if (pin.committed) continue;
    const dest = path.join(ROOT, pin.localPath);
    const result = fromClone
      ? await copyPinnedFile({ src: path.join(fromClone, pin.upstreamPath), pin, dest })
      : await fetchPinnedFile({ url: pinnedUrl(ds, key), pin, dest, timeoutMs: FETCH_TIMEOUT_MS });
    process.stdout.write(`${JSON.stringify({ type: 'ratio.sample-fetch', dataset: key, result, path: pin.localPath, bytes: pin.bytes, sha256: pin.sha256, commit: ds.commit })}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${JSON.stringify({ tag: 'ratio-sample-fetch', msg: 'failed', error: e.message })}\n`);
    process.exit(1);
  },
);
