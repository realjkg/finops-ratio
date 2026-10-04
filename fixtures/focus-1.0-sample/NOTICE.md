# FOCUS 1.0 Sample Data — attribution and licence

`focus_sample.csv` in this directory is **"FOCUS 1.0 Sample Data"** by the
**FinOps Foundation (FOCUS project)**. It is redistributed under the
**Creative Commons Attribution 4.0 International licence (CC BY 4.0)**:
https://creativecommons.org/licenses/by/4.0/

- Source repository: https://github.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data
- Commit: `adbdd17a132984d6e8583c149c236d2199c3f5bc`
- File: `FOCUS-1.0/focus_sample.csv`. It is 755,423 bytes, with SHA-256
  `e91e5ac7edf01ed2c9d926f37ef7dc1ae2aae97956fea8da6c9ee488b1c2839e`.
- Upstream description (`FOCUS-1.0/README.md` at that commit): "anonymized
  real world FOCUS data". This file contains AWS, Microsoft and Oracle rows
  only.

**Changes.** The file in this directory is **unmodified**: it is
byte-identical to upstream, and `dataset.json` pins its size and SHA-256.

The acceptance run (`npm run local:acceptance`, design in
`docs/evidence/slice-2b/DESIGN.md`) builds a **staged copy** in a throwaway
local S3 bucket, never in this repository. It makes these changes to the
copy:
1. every unquoted `NULL` field (a SQL null) becomes an empty field;
2. rows are split into one file per billing period;
3. each file is gzipped and laid out like an AWS Data Exports FOCUS 1.0
   export, with a manifest.

No value is otherwise altered.

The 10,000-row file (`FOCUS-1.0/focus_sample_10000.csv`, same commit, same
licence) is not committed. `npm run sample:fetch` downloads it on demand into
the gitignored `.ratio-sample-data/` and checks it against `dataset.json`.

Results derived from this data, such as the control totals in
`control-totals.json` and the run evidence in `docs/evidence/slice-2b/`, are
derived from the FinOps Foundation's FOCUS 1.0 Sample Data under CC BY 4.0.
This repository and its authors are not endorsed by the FinOps Foundation.
