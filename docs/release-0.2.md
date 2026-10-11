# MindTrust 0.2 release candidate

The implementation now targets an isolated hosted customer workspace, with a self-hosted option. It adds named team access, scoped credentials, a tested upstream SDK adapter, and operational recovery tooling to the original tracing/evaluation application.

## Release evidence

Local verification on Node 24.21.0 passed **68 tests**, strict TypeScript checks, and the production web build. The pinned Python 0.45.0 SDK contract passed on Python 3.12.14. The runtime dependency audit reported zero known vulnerabilities. Browser checks covered named sign-in, scoped viewer access, team administration, JSON migration, missing/null ground-truth editing, and the SDK experiment summary link.

The authoritative commands are `npm run check` and the pinned Python SDK contract harness documented in [compatibility](braintrust-compatibility.md). CI builds and smoke-tests the production container. Authentication/authorization tests exercise read and mutation boundaries, key revocation/expiry, cookies/CSRF, session revocation, and production configuration. Operational tests restore a live backup, reject corrupt files and existing destinations, enforce single-writer ownership across a killed process, and isolate identical resource IDs in separate customer databases.

The repeatable local workload is `npm run benchmark -- --traces 5000 --out docs/benchmark-local.json`. Its saved report identifies runtime/hardware, trace size, batching, concurrency, durability, sample counts, and timings. It is a local synthetic workload over loopback HTTP without TLS. It is not a test of Braintrust, production infrastructure, distributed ingestion, or a maximum safe capacity.

## Release gate

This remains a release candidate until all required checks pass and a representative customer accepts a parallel run. Passing the bundled SDK contracts establishes only the specific versioned workflows they execute. Read [production operations](production-operations.md) and [compatibility](braintrust-compatibility.md) before deploying or advertising support.
