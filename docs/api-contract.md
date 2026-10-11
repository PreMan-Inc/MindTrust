# MindTrust v0.2 API contract

Shared implementation contract. JSON field shapes live in `shared/types.ts`. All routes below have the `/api` prefix unless stated. List endpoints return arrays except traces, which return `{ items: Trace[], total: number }`. Errors return `{ error: string }` with appropriate 4xx/5xx status. Data persists in SQLite. No provider calls occur in the seeded demo.

Dataset rows carry `hasExpected`: an omitted expectation is different from an explicitly expected JSON `null`. This distinction survives import/export and revisions. Trials use **1-based indices**. Experiments carry `executionSource` (`server`, `sdk-import`, or `synthetic`); the placeholder task in imported results is not a record of the client-side function executed.

- `GET /health` → `{ status: 'ok' }`; `GET /info` → ServerInfo.
- `GET /projects` → Project[]; `POST /projects` `{ name, description? }` → Project.
- `GET /overview?projectId=...` → Overview.
- `GET /traces?projectId=...&search=...&status=...&limit=50&offset=0` → paginated roots. Search covers name, input, output, metadata, tags. Limit bounded at 200.
- `POST /traces` `{ projectId, traces: [{ id?, name, startTime?, endTime?, input?, output?, status?, tags?, metadata?, model?, costUsd?, inputTokens?, outputTokens?, spans?: Partial<Span>[] }] }` → `{ ids: string[] }`. Omitted timestamps use now. Supplied IDs permit idempotent replay/upsert; do not drop unsupplied existing spans. Explicit root metrics are authoritative; do not double-count parent plus child metrics.
- `GET /traces/:id` → TraceDetail; `GET /traces/export?projectId=...` → JSON array of full TraceDetail objects.
- `POST /annotations` `{ projectId, targetType, targetId, label, comment?, expected? }` → Annotation. `GET /annotations?projectId=...` → Annotation[].
- `GET /datasets?projectId=...` → Dataset[]; `POST /datasets` `{ projectId, name, description?, rows?: Partial<DatasetRow>[] }` → Dataset.
- `GET /datasets/:id?version=...` → DatasetDetail. `POST /datasets/:id/rows` `{ rows: Partial<DatasetRow>[] }` appends/upserts by row ID, atomically creates snapshot → DatasetDetail. `DELETE /datasets/:id/rows/:rowId` snapshots deletion → DatasetDetail.
- `GET /datasets/:id/export?version=...` → DatasetRow[]. `POST /datasets/:id/import` `{ rows: [...Braintrust exported input/expected/metadata/tags/id records] }` → DatasetDetail. Validate all rows before mutation. Accept `_id` as imported row identity if no `id`.
- `GET /scorers?projectId=...` → Scorer[]; `POST /scorers` `{ projectId, name, type, config?, description? }` → Scorer. Built-ins exact_match, contains, json_valid; no arbitrary server code execution. Config supports optional outputPath and expectedPath dot paths; missing fields must not pass a check.
- `GET /experiments?projectId=...` → Experiment[]; `POST /experiments` `{ projectId, name, description?, datasetId, datasetVersion?, scorerIds, task, trials?:1, concurrency?:4 }` → Experiment (202). Snapshot rows, scorers, and task before run. Bound trials 1–10/concurrency 1–16; preserve case failures. Echo returns input; template renders `{{input}}` or `{{input.field}}`; openai uses server configured provider and credentials. No remote arbitrary endpoints per request.
- `GET /experiments/:id` → ExperimentDetail; `POST /experiments/:id/cancel` → Experiment; `GET /experiments/:id/export` → ExperimentDetail.
- `GET /compare?baseline=...&candidate=...` → Comparison; align by row ID and trial, report unmatched rows and incompatible dataset revisions; do not manufacture comparable coverage.
- `POST /experiments/import` `{ projectId, name, datasetId, datasetVersion, cases: [{ rowId, trial?, input, expected, output, scores, latencyMs?, costUsd?, inputTokens?, outputTokens?, traceId?, error? }], description? }` imports independently executed SDK evals → Experiment. Validate dataset row membership and unique row/trial pairs.
- `GET /prompts?projectId=...` → Prompt[]; `POST /prompts` `{ projectId, name, description?, system?, template, model? }` → Prompt; `GET /prompts/:id` → `{ prompt, versions: Prompt[] }`; `POST /prompts/:id/versions` `{ system, template, model, description? }` → Prompt.
- `POST /playground` `{ projectId, task: TaskConfig, input: Json }` → `{ output, latencyMs, costUsd, inputTokens, outputTokens, traceId }`. Template mode is deterministic rendering, clearly labeled. Provider requires configured server API key and real network call.
- `GET /keys` → scoped key metadata; `POST /keys` `{ name, role, projectIds, expiresAt? }` → metadata & `{ key: string }` (plaintext returned once); `DELETE /keys/:id` revokes it. Workspace administrator required. Roles are `viewer`, `editor`, `admin`; `projectIds` is an explicit array or `null` for all projects. Production requires explicit role and scope. Expiry defaults to 90 days and is capped at 366 days. Store key hashes only.

## Team sessions and operations (0.2)

- `GET /auth/status` reports configured authentication and optional SSO availability. `POST /auth/login` accepts `{email,password}` and returns a principal/CSRF token plus an HttpOnly session cookie. `GET /auth/session` refreshes the current principal. `POST /auth/logout` revokes the session. Session mutations require `X-CSRF-Token`.
- `POST /auth/change-password` accepts `{currentPassword,newPassword}` from a signed-in user, revokes sessions, and requires a new sign-in.
- `GET/POST /users` and `PATCH /users/:id` manage named accounts, role, project scopes, disablement, and optional OIDC opt-in. `POST /users/:id/revoke-sessions` invalidates sessions. Workspace administrator required. Passwords require 12–256 characters and are stored as salted scrypt hashes.
- `GET /audit?limit=100` provides redacted audit events to administrators. `GET /operations` provides queue/readiness/memory state.
- Root paths `/livez` and `/readyz` are health probes; `/metrics` requires administrator authentication. The supplied public reverse proxy blocks operator endpoints.
- OIDC login/callback paths and the tested Braintrust wire endpoints are documented in [production operations](production-operations.md) and [compatibility](braintrust-compatibility.md).
- `POST /v1/traces` (no /api prefix): OTLP/HTTP JSON (`resourceSpans`), headers `x-mindtrust-project-id` or resource attribute `mindtrust.project_id`; preserve trace/span IDs, parents, status, nanosecond timestamps. JSON only, return standard `{ partialSuccess?: { rejectedSpans, errorMessage } }`. No protobuf claim.

Server implementation exports `createApp({ dbPath?, seed?, adminToken?, providerBaseUrl?, providerApiKey? })` returning `{ app, close, store }` for integration tests. Startup only in server/index.ts. Seed idempotent synthetic project `demo-project`, dataset `demo-dataset`, traces and two contrasting experiments, prompts/scorers, clearly marked synthetic metadata. No live customer or investor records.

Auth: when configured, Bearer token on every data route (health exempt). Bind localhost by default. Refuse non-loopback binding without admin token. No cross-origin allowance by default; validate browser Origin against serving host / local Vite to prevent cross-site writes. User-supplied provider URLs only from server environment. Server serves built `dist` at root; API 404 never falls through to SPA.
