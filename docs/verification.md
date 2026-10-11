# Verification record — October 11, 2026

This record covers the original application and the 0.2 isolated-workspace release candidate. It is not a comparative Braintrust benchmark or an enterprise-readiness certification.

## Automated checks

- Strict TypeScript check and Vite production bundle.
- API integration tests against isolated SQLite databases and real localhost HTTP requests.
- Persistence after restart, immutable dataset versions, atomic invalid imports, pinned evaluations, missing ground truth, trial alignment, and scorer error handling.
- Configured provider requests exercised against a local HTTP fixture, including token accounting without fabricated dollar prices. No paid model calls.
- Nested traces, out-of-order OTLP arrivals, repeat delivery, trace-scoped span IDs, timestamp normalization, and parent/child metric accounting.
- Authentication, revoked keys, hashed secret storage, cross-project resource references, browser origins, and hostile Host headers.
- Evaluation concurrency bounds, cancellation, malformed imported result provenance, and synthetic seed idempotence.
- SDK async parentage, buffer backpressure, retained failed batches, frozen dataset revisions, custom scorer failures, and active-worker cleanup.
- Named users, role/project restrictions, key expiry and revocation, session rotation, CSRF enforcement, password changes, and login throttling.
- OIDC against a local signed mock issuer: PKCE, nonce, audience, verified email, account binding, rejected signatures, and replay prevention. No live customer identity provider was configured.
- Live consistent backup and restore, corrupt backup rejection, refusal to overwrite destinations, process-lock crash recovery, bounded admission, graceful drain, and separate customer databases.
- Real official Braintrust SDK contracts for the pinned versions and workflows listed in [compatibility](braintrust-compatibility.md). These run against isolated local MindTrust services, not Braintrust's hosted API.

Run `npm run check` to reproduce the automated checks. Tests pass on the development Node.js 26 runtime and the supported Node.js 24 runtime; CI uses Node.js 24.

## Browser checks

Verified through the running application:

1. Read dashboard metrics and inspect a trace's nested spans, timings, inputs, outputs, and metadata.
2. Create a project; import two synthetic JSON records preserving their original IDs; inspect a historical empty dataset version.
3. Create an exact-match scorer and run two deterministic experiments. Confirm 0% and 100% results and aligned per-case comparison deltas.
4. Save a prompt, create a second version, load it in Playground, and confirm the rendered output and persisted trace.
5. Inspect a 390-pixel-wide viewport: responsive navigation and cards, no page-level horizontal overflow. Restore the normal viewport.

Browser testing caught and fixed empty status filters, new-project selection races, blank optional prompt models, and implicit use of observed output as expected output. UI verification data is synthetic and remains in the local development database, which is excluded from Git.

For 0.2, verified named administrator and viewer sign-in, sign-out, project visibility, disabled viewer editing controls, and the team access screens against a separate synthetic workspace. Imported two JSON examples through the migration UI, preserved their IDs, and saved a row without ground truth without adding an expected value. Created and reopened a separate example with explicit JSON null input and expectation. These checks caught and fixed the editor's accidental conversion of missing/null expectations.

Screenshots use synthetic accounts and data: [team access](images/team-access.jpg), [dataset migration](images/dataset-migration.jpg).

## Console workflow update

The revised console was verified on Node.js 24 with **76 passing tests**, strict TypeScript, and a Vite production build. Added tests cover server-wide sorting before pagination, null-last costs, allowlisted sort fields, chronological index usage, offset timestamps, cycle-safe/deep span hierarchies, missing-span dataset sources, ground-truth presence, and comparison categories.

Browser checks used only local synthetic data:

- Command search, keyboard selection, project switching, direct overview-to-experiment navigation, and project selection across reloads.
- Dataset tag filtering, inline example inspection, immutable snapshot history, explicit baseline/candidate selection, improvement filters, output comparison, and navigation to the underlying trace.
- Prompt search including no matches, deterministic Playground execution, persisted output, and opening its trace. No paid provider calls.
- Responsive page widths at 390, 820, and 1024 pixels, with the normal viewport restored afterward. Fixed legacy sidebar/main width rules that caused intermediate-width overflow.
- Logs: error filtering and sorting, empty search state, leaf-failure navigation, metadata, focused inspection, and 390-pixel mobile inspection. Saved a review and a dataset row in the separate UI verification project and confirmed their persisted history/version; the Atlas sample project was left unchanged.
- Browser console reported no JavaScript errors during these checks.

The visual comparison informed the original navigation, table, and inspection design. It does not establish complete Braintrust UI parity. Screenshots: [overview](images/mindtrust-overview.jpg), [experiment comparison](images/experiment-comparison.jpg), [trace inspector](images/trace-workbench.jpg).

## PreMan layout refinement

The console now follows PreMan’s neutral charcoal surfaces and compact controls. Browser checks covered overview activity tabs, log filters and span inspection, baseline/candidate comparison and case details, prompt search, and expandable integration guidance. At 390-pixel and 820-pixel widths there was no page-level horizontal overflow; short-screen trace payloads remain scrollable. Closed mobile navigation is hidden from keyboard focus, and dialogs lock the workspace scroller. The normal viewport was restored after responsive checks.

Node.js 24 typecheck, all 76 existing tests, and the production build passed. This pass changes presentation and navigation, with no API or persistence changes.

## Repeatable local workload

Run `npm run benchmark -- --traces 5000 --out docs/benchmark-local.json`. The saved JSON includes the runtime, hardware, request size, batching, concurrency, full-durability mode, ingestion results, and paginated query timings. This is a native-ingestion workload over loopback HTTP without TLS. It does not measure distributed behavior, production capacity, Braintrust compatibility ingestion performance, or another vendor's service.

## Limits of verification

Live commercial provider credentials were not used. The user-authorized Braintrust account inspection is recorded separately in [onboarding research](braintrust-onboarding.md); contract tests do not access that account. No distributed load, billing reconciliation, independent security audit, or cost/speed comparison has been performed. The local Docker daemon was unavailable, so production container/configuration validation runs in the repository's GitHub Actions workflow. Consult the successful run for the exact commit being deployed. A representative customer parallel run and recovery rehearsal remain required before migration.
