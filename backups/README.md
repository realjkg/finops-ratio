# Ratio local history preservation

The bundle preserves all 20 original unpublished commits through 21ec4d7633097d774a37eb7c970668de616b39ca. It requires base commit 732f59f57406becef0c7c95b74a640bb867ab6d9, already in this repository.

The feat/customer-workflow-simulation branch contains the identical source tree d7e2d2c108ce962f12c0cb717034cb8d83697d76, published using the GitHub connector because command-line Git authentication was unavailable. Its snapshot commit has a different SHA; the original history remains recoverable from this bundle.

To recover the original branch in an existing clone containing the base commit:

```sh
git bundle verify backups/ratio-customer-workflow.bundle
git fetch backups/ratio-customer-workflow.bundle HEAD:refs/heads/preserved/customer-workflow-original
git rev-parse preserved/customer-workflow-original
```

Expected original head: 21ec4d7633097d774a37eb7c970668de616b39ca.

Local lint/type checks and 2683 unit tests passed. Browser and PostgreSQL/S3/recovery acceptance remain open. No production-readiness claim or merge is implied.
