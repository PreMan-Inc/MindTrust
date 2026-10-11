# Architecture and operating boundaries

MindTrust v0.1 is a single-instance application for one trusted workspace. It implements a connected observability/evaluation workflow, not a distributed replacement for every Braintrust service.

## Components

- **React dashboard:** project selection, trace inspection, datasets, experiments, comparisons, prompts, playground, scorers, reviews, and instance access settings. UI operations use the same HTTP API as clients.
- **Express API:** validates requests and persists records. An optional instance administrator token and hashed API keys protect data access. Provider credentials never go to the browser.
- **SQLite storage:** WAL mode, parameterized SQL, project-scoped records, immutable dataset/prompt revisions, experiment manifests, and API key hashes. A database file is the persistence boundary.
- **Evaluation workers:** execute deterministic echo/template tasks or a configured OpenAI-compatible text completion provider with bounded concurrency. Dataset rows and scorer definitions are captured before execution.
- **Node.js SDK:** nested async-context tracing, buffered uploads, local task/custom scorer execution, and result import. Client code executes in the client's process, not inside the web server.
- **OTLP receiver:** accepts the HTTP JSON trace signal on `/v1/traces`. It is a limited mapping into the MindTrust schema, not a universal OpenTelemetry collector.

## Data flow

Instrument an application → upload a trace → inspect its spans → record a human judgment → explicitly supply the expected output → add a dataset row → run a pinned evaluation → compare individual cases against a baseline.

The source trace ID is stored in dataset metadata. Dataset changes produce new revisions; old experiments retain their inputs and expectations. Prompts are versioned independently. UI-run evaluations carry task text/configuration rather than a mutable reference to the latest prompt. SDK runs store their resulting inputs, outputs, errors, and scores; they do not package the user's executable source.

## Comparison semantics

MindTrust pairs cases by **dataset row ID and trial number**. Braintrust's documented default pairs identical inputs. Imports should preserve IDs when intentional case continuity exists. Dataset revision changes, scorer changes, and unmatched cases must be considered before interpreting score deltas.

A missing score is `null`, not zero. Task and scorer errors stay visible. Average quality among scored cases is not proof that every required case passed. Human annotations do not overwrite automatic scores or historical expected outputs.

## Cost semantics

Costs supplied by instrumentation are caller-reported USD. No model price catalogue or billing reconciliation exists. Live provider runs preserve unknown dollar cost even when token counts are known. Zero-cost local template/echo execution means **no provider charge**, not zero infrastructure or engineering cost. Synthetic seed costs are illustrative fixture values.

Root trace metrics are authoritative when supplied. Instrumentation should report per-operation values in child spans and avoid repeating cumulative parent usage as independent billable events. Unknown costs are counted separately in dashboards; known spend is a partial sum, not a full bill.

## Access and deployment

Without an administrator token, the server is for localhost development. Network binding beyond loopback requires `MINDTRUST_ADMIN_TOKEN`. All data routes require a bearer token when authentication is configured; key management requires the administrator token. API keys have instance-wide data access, **not project-specific RBAC**.

Browser origins are checked, and cross-origin access is not generally enabled. The UI can keep a token in session storage for the current tab/session. Use a TLS reverse proxy and network restrictions for remote use. There is no account system, SSO, SCIM, tenant isolation, per-user audit trail, or compliance certification.

## Persistence and recovery

Dataset updates and snapshots are transactional. Evaluation manifests and finished case results are persisted, but provider side effects cannot be atomically committed with SQLite. A process interruption can require retrying in-flight work; use idempotent tasks and do not evaluate against destructive production operations. Cancellation cannot undo external effects that have already occurred.

Run one API process per database file. Synchronous SQLite and whole-document datasets are deliberately simple; they are not a demonstrated high-throughput architecture. Back up the database while the service is stopped, or use SQLite's online backup API. Copying only the main file while WAL writes are active is not a valid backup procedure. Retention, automatic backup, and schema migration tooling are future work.

## Deliberate omissions

This version does not implement Brainstore/BTQL, the Braintrust wire protocol, remote code sandboxes, automatic online scoring, a model-routing gateway, streaming completions, cache/fallback policies, distributed ingestion, alert delivery, review assignments, attachment storage, Loop, Topics, Patterns, or enterprise administration. These gaps and their replacement requirements are documented in the research report.

The SDK and the app are independently authored. Publicly observable concepts informed their design; no Braintrust server implementation or private API was accessed.
