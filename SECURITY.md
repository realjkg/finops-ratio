# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/realjkg/finops-ratio/security/advisories) on this repository. This keeps the report confidential until a fix is published.

When reporting, please include — where applicable:

- The affected component or route (e.g. app router path, worker CLI, ingestion transport).
- A minimal reproduction or proof of concept.
- The impact you observed (what an attacker could do).
- Any suggested fix.

## Scope

In scope: the Next.js application (`src/app`), the ingest worker and its CLI (`src/ingest`), cost-source transports and their credential/redaction handling (`src/costsource`), the local simulation stack (`infrastructure/`), and the CI/governance workflows (`.github/`).

Out of scope: vulnerabilities in dependencies that only reproduce on end-of-life runtime versions this project does not support, and findings requiring physical access or a compromised host.

## What to expect

Reports are triaged as soon as practical. Confirmed vulnerabilities are fixed on `main` and published; credit is given unless you prefer to remain anonymous.

## Supported versions

Only the latest `main` branch (and releases cut from it) receives security fixes.

## Handling of cost data and credentials

The platform processes cloud cost data and brokered AI-provider credentials. Committed fixtures are synthetic; `.env` files and generated local secrets (`.ratio-local/`) are gitignored and must never be committed. The log-redaction modules (`src/ingest/redact.ts`, `src/costsource/transports/redact.ts`) are security-relevant code — changes there should preserve the linear-time redaction guarantees covered by the test suite.
