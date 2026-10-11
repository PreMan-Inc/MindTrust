# Verification record — October 10, 2026

This record covers the original implementation in this repository. It is not a comparative Braintrust benchmark.

## Automated checks

- Strict TypeScript check and Vite production bundle.
- API integration tests against isolated SQLite databases and real localhost HTTP requests.
- Persistence after restart, immutable dataset versions, atomic invalid imports, pinned evaluations, missing ground truth, trial alignment, and scorer error handling.
- Configured provider requests exercised against a local HTTP fixture, including token accounting without fabricated dollar prices. No paid model calls.
- Nested traces, out-of-order OTLP arrivals, repeat delivery, trace-scoped span IDs, timestamp normalization, and parent/child metric accounting.
- Authentication, revoked keys, hashed secret storage, cross-project resource references, browser origins, and hostile Host headers.
- Evaluation concurrency bounds, cancellation, malformed imported result provenance, and synthetic seed idempotence.
- SDK async parentage, buffer backpressure, retained failed batches, frozen dataset revisions, custom scorer failures, and active-worker cleanup.

Run `npm run check` to reproduce the automated checks. Tests pass on the development Node.js 26 runtime and the supported Node.js 24 runtime; CI uses Node.js 24.

## Browser checks

Verified through the running application:

1. Read dashboard metrics and inspect a trace's nested spans, timings, inputs, outputs, and metadata.
2. Create a project; import two synthetic JSON records preserving their original IDs; inspect a historical empty dataset version.
3. Create an exact-match scorer and run two deterministic experiments. Confirm 0% and 100% results and aligned per-case comparison deltas.
4. Save a prompt, create a second version, load it in Playground, and confirm the rendered output and persisted trace.
5. Inspect a 390-pixel-wide viewport: responsive navigation and cards, no page-level horizontal overflow. Restore the normal viewport.

Browser testing caught and fixed empty status filters, new-project selection races, blank optional prompt models, and implicit use of observed output as expected output. UI verification data is synthetic and remains in the local development database, which is excluded from Git.

## Limits of verification

Live commercial provider credentials were not used. No Braintrust account or private API was accessed. No large-scale durability, distributed load, billing reconciliation, or cost/speed comparison has been performed. Docker configuration is included, but a container build was not run because the local Docker daemon was unavailable. A passing production bundle means the app can be built; it is not an enterprise-readiness certification.
