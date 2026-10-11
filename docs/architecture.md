# Architecture and operating boundaries

MindTrust v0.2 is a release candidate for an isolated customer workspace with named users and project-scoped permissions. A separate service process, database, identity-provider configuration, and secrets form each customer's boundary. It implements a connected observability/evaluation workflow; it is not a distributed replacement for every Braintrust service.

## Components

- **React dashboard:** project selection, trace inspection, datasets, experiments, comparisons, prompts, playground, scorers, reviews, and instance access settings. UI operations use the same HTTP API as clients.
- **Express API:** validates requests and enforces viewer/editor/admin access on every resource path. Password/OIDC sessions use HttpOnly cookies and CSRF tokens; application keys carry project scopes and expiry. Provider credentials never go to the browser.
- **SQLite storage:** WAL mode, parameterized SQL, project-scoped records, immutable dataset/prompt revisions, experiment manifests, and API key hashes. A database file is the persistence boundary.
- **Evaluation workers:** execute deterministic echo/template tasks or a configured OpenAI-compatible text completion provider with bounded concurrency. Dataset rows and scorer definitions are captured before execution.
- **Node.js SDK:** nested async-context tracing, buffered uploads, local task/custom scorer execution, and result import. Client code executes in the client's process, not inside the web server.
- **OTLP receiver:** accepts the HTTP JSON trace signal on `/v1/traces`. It is a limited mapping into the MindTrust schema, not a universal OpenTelemetry collector.
- **Braintrust adapter:** validates a bounded upstream protocol, stores raw event fields, and materializes native traces/datasets/experiments. Pinned official SDK contract tests exercise the implemented surface; see [compatibility](braintrust-compatibility.md).

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

Unauthenticated access is limited to local development. Production requires a strong bootstrap/recovery token and exact HTTPS origins. Personal accounts use salted scrypt password hashes or opt-in OIDC identities. Viewer/editor/admin roles and project allowlists apply to sessions and API keys; key and user administration require workspace-admin access. Revocation and permission changes are consulted on subsequent requests.

Browser origins are checked. Normal human sessions use Secure/HttpOnly/SameSite cookies in production, with CSRF validation on mutations. The bootstrap-token fallback uses session storage for that tab. OIDC validates signed tokens, issuer/audience, state, nonce, PKCE, browser binding, and preprovisioned identity linkage. Audit records omit content and credentials. Customers are isolated by deployments; a shared multi-tenant control plane, SAML/SCIM, and compliance certification are not implemented.

## Persistence and recovery

Dataset updates and snapshots are transactional. Evaluation manifests and finished case results are persisted, but provider side effects cannot be atomically committed with SQLite. A process interruption can require retrying in-flight work; use idempotent tasks and do not evaluate against destructive production operations. Cancellation cannot undo external effects that have already occurred.

Run one API process per database file. The entry point acquires an OS-backed SQLite lock separate from application writes; it releases after a crash. SQL pagination and aggregation avoid loading every trace into Node. Evaluation scheduling bounds active jobs and task concurrency. SQLite and whole-document dataset snapshots still impose scale limits. The backup CLI uses SQLite's online backup API, verifies integrity/checksums, and only restores to a new path. Unknown future database versions are refused. Offsite scheduling, retention, replication, and high availability remain operator or future engineering work; see [production operations](production-operations.md).

## Deliberate omissions

This version does not implement Brainstore/general BTQL, the complete Braintrust protocol, remote code sandboxes, automatic online scoring, a model-routing gateway, streaming completions, cache/fallback policies, distributed ingestion, alert delivery, review assignments, attachment storage, Loop, Topics, or Patterns. These gaps and their replacement requirements are documented in the research report. The implemented team controls are not a claim of enterprise compliance.

The SDK and the app are independently authored. Publicly observable concepts informed their design; no Braintrust server implementation or private API was accessed.
