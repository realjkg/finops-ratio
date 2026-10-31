# AWS Data Exports (FOCUS) managed connector

Status: **Implemented and pre-release validated; live verification scheduled for MVP rollout.**

This connector reads an AWS Billing and Cost Management Data Exports **FOCUS** export (CSV, GZIP)
from the customer's S3 bucket, driven by the export's manifest. It runs only in the worker
(`cli fetch`), never from a web request. It has been proven against a SYNTHETIC local S3 store and
the public FOCUS 1.0 sample only. Nothing in this document has been checked against a real AWS
account; every vendor fact below is marked **NOT VERIFIED** where the code relies on it.

Code: `src/connectors/managed/aws/focusRetriever.ts` (retriever, staging normalizer, probe) and
`src/connectors/managed/aws/s3ClientFromSecret.ts` (per-source credentials). CUR 2.0 is a separate
row (M1b) and is refused here (`TABLE_UNSUPPORTED`).

## What it does

1. Lists `<prefix>/<exportName>/metadata/` and reads one `*Manifest.json` per
   `BILLING_PERIOD=YYYY-MM` folder. The manifest's `dataFiles` define the delivery. Files the
   manifest does not list are never read. Every read is pinned to the listed ETag (`If-Match`).
2. Hands each data file's ORIGINAL bytes (gzip, as delivered) to the managed runtime. The runtime
   stores them as evidence (`connector-originals/<tenant>/<source>/<sha256>`) and then stages them
   through the import pipeline (`stageAndSync`: validator, reconciliation, publish or quarantine,
   restatement guard). The connector never publishes on its own.
3. At staging, the registered normalizer (`aws-focus-export@1.0` / `@1.2`) decompresses the file,
   reads the header, detects the FOCUS version from the columns, and records it in the batch's
   staged manifest (`x-ratio-import.normalization[].versions`) as separate fields: the declared
   export table (`exportSchemaVersion`) and the observed header version (`sourceFocusVersion`),
   with the column snapshot and its sha256.
4. The delivery id is `aws-focus YYYY-MM manifest-sha256:<sha256> selection:<rule>`, so every staged
   batch names the exact manifest it came from. A refreshed manifest is a new revision: the period
   is refused (`PERIOD_ALREADY_PUBLISHED`, exit 3) until the operator re-runs with `--restate`, which
   supersedes the published batch.
5. Manifest controls (per-file row counts and similar) are **not persisted** by a real fetch and are
   never used as completeness proof or passed to reconciliation: without an operator control total
   the period publishes as `unverified`. What a real fetch records is the delivery id (it carries
   the manifest's sha256, item 4) and the normalization versions in the batch's staged manifest
   (`x-ratio-import`, item 3). The library function `deliveryEvidence()` builds an in-memory
   aggregate-control record (`control: aggregate, proof: false`), but only unit tests call it; no
   Connector Evidence Record is written from it yet (no M0a/M0b hook exists for that).
6. A range-less fetch (no `--from/--to`) reads only the periods the export has. If a month between
   the first and last delivered month has no folder at all, the fetch still succeeds and the result
   carries a `warnings` entry listing those gap months. Give `--from/--to` to get a
   `PERIOD_NOT_DELIVERED` refusal for them instead. The warning never fails a fetch, whatever the span of delivered months (the 36-month cap applies only to an explicit `--from/--to`); it names up to 24 gap months and counts the rest.

## Refusals (never a silent empty period)

| Code | When |
|---|---|
| `EXPORT_EMPTY` | The export's metadata folder has no billing-period partition. |
| `PERIOD_NOT_DELIVERED` | A month inside `--from/--to` has no delivery. |
| `LAYOUT_CASE_MISMATCH` | The partition is spelled other than `BILLING_PERIOD=` (for example lower case). |
| `MANIFEST_MISSING` / `MANIFEST_INVALID` | No manifest, or one that is malformed, lists a missing file, or points outside the export (another bucket, another folder, a `..` path). Under `latest-complete`, also a newer manifest that is invalid (see below). |
| `MANIFEST_AMBIGUOUS` | More than one manifest for a period (default rule; see below). |
| `FORMAT_UNSUPPORTED` | Parquet or ZIP data files (1.0 limit: TEXT_OR_CSV with GZIP only). |
| `FOCUS_TABLE_MISMATCH` | The manifest names another table than `params.table`. |
| `FOCUS_VERSION_MISMATCH` / `FOCUS_VERSION_UNKNOWN` | The header's columns are not the configured FOCUS version. |
| `HEADER_CASE_MISMATCH` | FOCUS column names in another case (for example the lower-case Glue form). |
| `IMPORT_TOO_LARGE` | A delivery above the 128 MiB import cap. |

**Manifest selection.** The default rule (`manifestSelection: single`) keeps the durable source's
`MANIFEST_AMBIGUOUS` refusal. Whether a `CREATE_NEW_REPORT` export leaves several manifests per
period is NOT VERIFIED. `manifestSelection: latest-complete` (use the newest manifest whose data
files all exist; a LastModified tie stays ambiguous) is accepted only together with
`manifestSelectionEvidence: sha256:<hex>`, the digest of the live Connector Evidence Record that
proved the rule. Turning it on is an owner decision after the live verification below.

Under `latest-complete`, a newer manifest whose listed files have **not landed yet** is skipped and
the newest complete one is used. A newer manifest that is **invalid** (malformed JSON, a file in
another bucket or outside the export's data folder, a `..` path, a wrong billing period, an
unsupported scheme, or a manifest that lists no data files) refuses the period with `MANIFEST_INVALID`; the older manifest is never
published in its place. An invalid manifest with the same LastModified as the newest complete one
cannot be ordered and also refuses. An invalid manifest that is strictly older than the chosen one
is ignored.

## Configuration

Engagement config (`RATIO_ENGAGEMENT_CONFIG`), one source:

```json
{ "id": "aws-focus", "retrieval": { "kind": "managed", "connector": "aws-data-exports", "secretRef": "aws/focus",
  "params": { "bucket": "<export bucket>", "prefix": "<S3Prefix of the export>", "exportName": "<export name>",
              "region": "<bucket region>", "table": "FOCUS_1_2_AWS" } } }
```

- `table`: `FOCUS_1_2_AWS` (name as used by the AWS CID templates; NOT VERIFIED against
  `ListTables`) or `FOCUS_1_0_AWS` (NOT VERIFIED; seen only in third-party code).
- `endpoint` (optional): an `https://` origin for an S3-compatible endpoint; `http://` only for a
  loopback test store. Without it the client uses the regional AWS endpoint.
- `bucket`, `prefix` and `exportName` (owner-approved schema change, 2026-10-30) are checked at
  startup and by the worker with field rules instead of R1's generic 40-character credential rule:
  `bucket` is an S3 general purpose bucket name (3 to 63 lowercase letters, digits, dots and
  hyphens, letter or digit at both ends, no `..`, not an IP address, no `xn--`, `sthree-`,
  `amzn-s3-demo-` prefix or `-s3alias`, `--ol-s3`, `.mrap`, `--x-s3`, `--table-s3` suffix; the
  reserved names are NOT VERIFIED in this repo); `exportName` is 1 to 128 of `[0-9A-Za-z_-]` (the
  Data Exports API model); `prefix` is valid UTF-8 with no control characters, leading or trailing
  slash, or empty, `.` or `..` segments, and the longest object key the retriever builds
  (`<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/` plus 256 bytes reserved for the run
  folder and file name AWS chooses) must fit S3's 1,024-byte key limit. Credential shapes are
  refused anywhere inside these fields, in the value and in its NFKC form (fullwidth lookalikes):
  `(AKIA|ASIA)[A-Z0-9]{16}` (no word boundaries, so a name containing such a run of capitals is
  refused; lowercase `akia` is fine), a JWT `eyJ…….……` even after other text, a `-----BEGIN …-----`
  private key header, `secret|password|passwd|token|credential|signature|api_key|apikey|access_key`
  followed by optional spaces and `=` or `:` (any case), and URL userinfo (`:` then `@` in one
  segment). Nothing is refused for looking random. Other params keep the generic rule. The
  retriever's own check (layout.ts) is stricter (ASCII prefix segments, at most 512 characters; an
  export name must start with a letter or digit) and refuses such values when `fetch` runs.
- The worker also needs a file-import source with the same key (`cli source add`), which receives
  the staged objects.

Secret file `RATIO_SECRETS_DIR/aws/focus` (mode 0600, JSON, one of):

```json
{ "kind": "assume-role", "roleArn": "arn:aws:iam::<customer account>:role/<role>", "externalId": "<issued by the owner>",
  "accessKeyId": "<operator principal key id>", "secretAccessKey": "<operator principal secret>" }
```

```json
{ "kind": "static", "accessKeyId": "<key id>", "secretAccessKey": "<secret>" }
```

Credentials, region and endpoint come only from the secret file and the params. The AWS SDK
default credential chain, `AWS_*` environment variables, profiles and configured endpoint URLs are
never used. Assume-role sessions are cached until five minutes before they expire.

## Access request (hand this to the customer's AWS administrator)

We ask for **read-only** access to one Data Exports FOCUS export. We never ask for, and you should
never send, root or console credentials. Recommended: a role in the account that owns the export
bucket, assumable by the operator's principal with an ExternalId that the owner issues.

Minimum permissions used by this build (action names NOT VERIFIED against a live account):

| Action | Resource | Why |
|---|---|---|
| `s3:ListBucket` | `arn:aws:s3:::<bucket>`, condition `StringLike s3:prefix = <S3Prefix>/<export name>/*` | List the export's metadata and data folders. |
| `s3:GetObject` | `arn:aws:s3:::<bucket>/<S3Prefix>/<export name>/*` | Read manifests and the data files they list (including ranged reads for the health check). |
| `kms:Decrypt` | the bucket's KMS key, condition `kms:ViaService = s3.<region>.amazonaws.com` | Only if the bucket uses SSE-KMS. |

Trust policy on the role: allow `sts:AssumeRole` for the operator's principal ARN (supplied by the
owner) with condition `StringEquals sts:ExternalId = <ExternalId>`.

Not requested by this build: any write action, `s3:ListAllMyBuckets`, `s3:GetBucketLocation` (the
region is configured), and `bcm-data-exports:GetExport` / `GetExecution` (not called yet; the
export definition is captured manually during live verification).

Please also tell us: bucket, S3Prefix, export name, bucket region, the export's table
(`FOCUS_1_2_AWS` or other), format and compression (we support TEXT_OR_CSV with GZIP), and the
overwrite setting (`OVERWRITE_REPORT` or `CREATE_NEW_REPORT`).

## Health check

The probe reports four stages in order, and "connected" only when all pass:
`auth` (the credential is accepted; AssumeRole succeeds), `scope` (the metadata folder can be
listed), `data` (the latest period's manifest is read and complete), `contract` (the head of one
data file is read with a ranged GET and its header is the configured FOCUS version). It is a
library function (`probeManaged`); there is no worker command for it in this build, so the live
check below uses `fetch`.

## Live verification at MVP rollout

Goal: move this connector from fixture-verified to live verified for one customer account. Until
every step passes, the status stays "Implemented and pre-release validated; live verification
scheduled for MVP rollout".

**What the owner and infrastructure grant first**

1. The customer's written authorization (account, export, months) and the role, policy and trust
   above. The owner issues the ExternalId; the owner's infrastructure provides the operator
   principal whose key pair goes into the secret file.
2. The secret file on the worker's read-only secrets mount (`RATIO_SECRETS_DIR/aws/focus`, 0600).
3. The engagement config entry above, with the customer's bucket, prefix, export name, region and
   table.
4. **Pending owner decision:** R1's `SUPPORTED_IN_THIS_BUILD` does not yet allow managed retrieval
   for this connector (see the M1a pull request); the worker's `fetch` reads its own check of the
   engagement config, but startup validation of the instance refuses a managed source until that
   is enabled.

**Commands the operator runs (one closed month, for example 2026-10)**

```sh
npm run -s worker -- source add --tenant <tenant uuid> --key aws-focus --providers AWS --bucket <staging bucket> --prefix <staging prefix>
npm run -s worker -- fetch --tenant <tenant uuid> --source aws-focus --from 2026-10 --to 2026-10 > fetch-1.json
npm run -s worker -- fetch --tenant <tenant uuid> --source aws-focus --from 2026-10 --to 2026-10 > fetch-2.json   # must be unchanged
```

**What to capture (restricted evidence store only, never the repository)**

- `fetch-1.json` and `fetch-2.json` (the CLI evidence records; secrets are redacted).
- The originals the run stored (`connector-originals/<tenant>/<source>/<sha256>`), and from the
  customer administrator: the unmodified manifest, the S3 listing of the period (keys, sizes,
  ETags), the export definition (`GetExport` output: table, TableConfigurations, format,
  compression, overwrite), and the console or invoice total for the same month and scope.
- The batch's staged manifest (`x-ratio-import`): delivery id with the manifest sha256, and the
  recorded `versions` (declared table, observed FOCUS version, column snapshot sha256).
- If the period had several manifests (`MANIFEST_AMBIGUOUS`): every manifest of the period with its
  LastModified, which is the evidence for or against `latest-complete`.

**Acceptance criteria**

1. `fetch-1` exits 0; one delivery per month; outcome `staged`; the period is published.
2. Every original's sha256 matches the object the manifest lists (from the customer's listing), and
   no object outside the manifest was read.
3. The observed FOCUS version equals the configured table; the column snapshot is recorded and its
   sha256 pinned in the evidence record.
4. Published billed cost per currency equals the console or invoice total for the same month and
   scope, or every difference is explained line by line in the accounting bridge (credits, tax,
   timing). No unexplained difference is accepted.
5. `fetch-2` reports the period `unchanged` and the originals `exists`.
6. After AWS refreshes the month (or a later closed month is refreshed), `fetch` without
   `--restate` exits 3 and changes nothing; with `--restate` it supersedes the batch.
7. No secret value (key id, secret, session token, ExternalId) appears in any output or stored
   record.
8. The NOT VERIFIED items below are each confirmed or corrected in the code, with a test.

Then the owner builds the Connector Evidence Record (`fixtureClass: original`, customer validation
`validated`). Only when all four readiness dimensions are live may the status say live verified.

## NOT VERIFIED (vendor facts the code relies on)

- The S3 layout `<prefix>/<export>/{data,metadata}/BILLING_PERIOD=YYYY-MM/` and the upper-case
  partition name (one third-party report shows lower case; this build refuses it).
- Manifest field names `dataFiles` (keys or `s3://` URIs) and `billingPeriod.start`, and whether a
  manifest names its table.
- Whether `CREATE_NEW_REPORT` leaves more than one manifest per period.
- Table names `FOCUS_1_0_AWS` and `FOCUS_1_2_AWS`, and that the CSV header uses the FOCUS column
  names in their spec case.
- IAM action names and the minimum policy above; the regional STS endpoint form.
