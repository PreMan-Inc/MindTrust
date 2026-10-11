# Braintrust: public behavior and MindTrust implementation requirements

Research date: **October 10, 2026**. Sources: Braintrust's public documentation, product pages, published API specification, and public JavaScript SDK repository. This document describes observed public contracts and independently proposed implementation choices. It does not claim access to Braintrust's private backend, customer data, or internal design.

**Documented** means supported by a linked primary source. **Design recommendation** means a proposed MindTrust behavior; it is not a claim about Braintrust or a statement that MindTrust already implements it. Check the repository README and tests for the delivered implementation's current scope.

## 1. What has to be replaced

Braintrust connects instrumenting applications, investigating production behavior, collecting human feedback, constructing datasets, evaluating changes, and monitoring deployments. The product's value comes from moving the same examples and evidence through this cycle. A collection of visually similar pages would not replace that workflow. [Product documentation](https://www.braintrust.dev/docs), [workflow](https://www.braintrust.dev/docs/workflow).

The useful unit of replacement is therefore a complete feedback loop:

1. Capture a real request with nested spans and useful metadata.
2. Find a failure and inspect its input, output, timing, tool calls, and scores.
3. Add human judgment and turn the example into a reproducible test case.
4. Run a candidate against a pinned dataset and scorer configuration.
5. Compare the candidate with a baseline, including individual regressions.
6. Promote the chosen configuration and continue observing it.

**Design recommendation:** Make this loop work with persisted user data first. A seeded demo should be explicitly identified, never presented as collected customer activity.

## 2. Product inventory and consequential behavior

### Tracing and application logs

**Documented:** Braintrust captures LLM calls and arbitrary application operations. Function wrappers/decorators record arguments, outputs, errors, and nesting. Spans can carry metadata and tags; tags are aggregated across a trace. Trace viewers expose individual operations rather than only a request summary. [Application tracing](https://www.braintrust.dev/docs/instrument/trace-application-logic), [trace inspection](https://www.braintrust.dev/docs/observe/examine-traces).

The SDK buffers records and uploads batches asynchronously. Explicit flushing matters during shutdown, especially in short-lived processes. Queue bounds, retry controls, and backpressure are documented; successful application execution does not imply successful telemetry delivery. [Advanced tracing](https://www.braintrust.dev/docs/instrument/advanced-tracing).

**Design recommendation:** Preserve separate row, trace, and span identifiers. Accept children before parents without discarding them. Expose errors, unfinished spans, and unknown token/cost fields distinctly. Attribute usage to billable leaf operations so parent totals cannot double-count descendants.

### Datasets and reproducibility

**Documented:** Dataset records center on JSON `input`, optional `expected`, and metadata. Inserts, edits, and deletes are versioned. Experiments can pin a dataset version. Named snapshots provide checkpoints that can be viewed, evaluated, restored, and assigned to environments; snapshot availability is plan-dependent. The documented schema-enforcement feature applies to UI editing, not SDK writes. [Datasets](https://www.braintrust.dev/docs/guides/datasets), [dataset management](https://www.braintrust.dev/docs/annotate/datasets/manage).

**Design recommendation:** Use immutable revision records and stable case identities. Store the revision selected when a run starts, even if the live dataset changes. Editing expected output after an experiment must not rewrite that experiment's evidence. Preserve provenance when creating a case from a trace.

### Experiments and execution

**Documented:** An evaluation combines data, a task, and scorers. SDK execution creates a recorded experiment. Configuration includes concurrency, repeated trials, and metadata. Tasks can execute locally or in CI; the UI also supports evaluation workflows. [Code evaluation](https://www.braintrust.dev/docs/evaluate/run-in-code), [CI evaluation](https://www.braintrust.dev/docs/evaluate/run-in-ci).

Remote evaluations run the customer's code on their infrastructure while Braintrust initiates runs and receives results. Sandboxes execute packaged artifacts and are identified as public preview; Lambda and Modal have distinct supported environments. [Remote evaluations and sandboxes](https://www.braintrust.dev/docs/evaluate/remote-evals).

**Design recommendation:** Persist a run manifest before execution, record task failures separately from scorer failures, and retain completed rows after partial failure. A rerun should create a new experiment, not silently replace the baseline. Expose cancellation and timeout semantics before claiming long-running agent support.

### Comparison and release decisions

**Documented:** Braintrust matches test cases by identical `input` by default. Users can configure a comparison key using a SQL expression when volatile fields make inputs differ. It supports project/experiment baselines, per-case score changes, regression filtering, output diffs, and pairwise human preference scoring. [Experiment comparison](https://www.braintrust.dev/docs/evaluate/compare-experiments).

**Design recommendation:** MindTrust may prefer dataset case IDs, but this is a deliberate semantic difference. Show unmatched cases, changed dataset revisions, and changed scorer definitions. A missing baseline score is not zero; a task error is not an automatic pass. Display paired sample counts alongside averages. Never let a higher overall average conceal a failing required case.

### Scorers and classifiers

**Documented:** Scorers return numeric values from 0 to 1; classifiers return categories. Evaluators may inspect input, output, expected output, metadata, and trace context. Braintrust supports prebuilt Autoevals, code evaluators, and LLM judges, with span-level and trace-level evaluation. Scorers/classifiers are versioned. [Scorer contract](https://www.braintrust.dev/docs/evaluate/write-scorers), [Autoevals](https://www.braintrust.dev/docs/evaluate/autoevals).

Online scoring applies evaluators asynchronously to production data with filters, sampling, and span/trace/group scopes. Group sampling determines whether a run is triggered, rather than which context traces are included. [Online scoring](https://www.braintrust.dev/docs/evaluate/score-online).

**Design recommendation:** Start with named deterministic scorers and explicit parameters. Persist a scorer definition snapshot per run. Validate numeric bounds and report scoring errors. Arbitrary uploaded Python/JavaScript requires a separate hardened runtime; evaluating arbitrary source inside the web server is not a safe substitute.

### Prompts and playgrounds

**Documented:** Prompts include model configuration, messages, templates, and output settings. Saves create versions; versions can be pinned or assigned to environments. Without a pin, applications may use the latest version. [Prompt creation](https://www.braintrust.dev/docs/evaluate/prompts/create), [prompt versions](https://www.braintrust.dev/docs/evaluate/prompts/versions).

Playgrounds compare tasks/models/configurations interactively, show outputs and scores, and allow results to be promoted to an experiment. Playground reruns overwrite their previous results, whereas saved experiments preserve the run. Controls include concurrency and dataset sampling. [Playgrounds](https://www.braintrust.dev/docs/evaluate/playgrounds).

**Design recommendation:** Keep prompt revisions separate from mutable editor state. Record the rendered prompt and configuration used for a run. Missing credentials must produce an actionable error; synthetic output must never masquerade as a live provider response.

### Human annotation

**Documented:** Rows in logs, experiments, and datasets can be assigned for human review. The review workflow tracks assignments and supports structured scores, comments, and dataset curation. Multiple reviewers' scores are retained independently. Numeric judgments can be averaged, while nonnumeric values require choosing a base value. Braintrust includes controls to reduce exposure to peers' judgments before a reviewer finishes. [Review assignments](https://www.braintrust.dev/docs/annotate/human-review/manage-review-work), [multiple reviewers](https://www.braintrust.dev/docs/annotate/human-review/multiple-reviewers).

**Design recommendation:** Store reviewer identity, time, target, judgment, and rubric version separately from automatic scores. A single anonymous comment box is useful, but is not team-review parity.

### Search, query, dashboards, and alerts

**Documented:** Braintrust offers structured filtering and a SQL interface across logs, experiments, and datasets. Standard SQL syntax is recommended over legacy pipe-style BTQL. Its SQL dialect is not general PostgreSQL: the reference lists unsupported constructs including joins, set operations, and window functions. The `/btql` endpoint executes queries, and large result sets use cursor pagination. [SQL reference](https://www.braintrust.dev/docs/reference/sql), [query API](https://www.braintrust.dev/docs/api-reference/query).

Dashboards support aggregates and drill-down; alerts cover matching logs, calculations over time windows, and environment changes. Alert delivery supports Slack and webhooks, with documented batching and suppression behavior. [Dashboards](https://www.braintrust.dev/docs/observe/dashboards), [alerts](https://www.braintrust.dev/docs/observe/alerts).

**Design recommendation:** Basic filters and fixed charts are a useful first slice. Do not label them SQL/BTQL compatible unless queries are parsed and semantics tested. Publish metric denominators, time zones, and null handling. Arbitrary database SQL must not be exposed to untrusted browser input.

### OpenTelemetry and integrations

**Documented:** OTLP routes include `/otel/v1/traces` and `/otel/v1/logs`. A bearer token authenticates ingestion; `x-bt-parent` routes to a project, experiment, or exported span context. LLM attributes map into specialized spans. Logs can correlate with spans while maintaining distinct row IDs. Braintrust documents partial rejection handling and warns that children without a root do not appear as root traces in the logs table. [OTLP ingestion](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry/send-traces-and-logs).

The integration catalogue spans model providers, agent frameworks, testing frameworks, IDE/agent tools, and MCP. Harbor integration imports cases, trials, verifier rewards, artifacts, and trajectories; deterministic identities make backfills reconcile rather than duplicate data. [Integration catalogue](https://www.braintrust.dev/docs/integrations), [Harbor](https://www.braintrust.dev/docs/integrations/sdk-integrations/harbor).

**Design recommendation:** If the first receiver only accepts OTLP/HTTP JSON, state that explicitly. It must not imply protobuf, gRPC, log-signal, or all semantic-convention support. Keep unfamiliar attributes intact for future remapping.

### Gateway and provider operations

**Documented:** Braintrust offers a unified provider gateway, separate from telemetry ingestion. Its response cache has configurable modes and TTL; it distinguishes gateway response caching from a provider's prompt cache. Documented controls expose cache hits/misses and provider fallbacks. [Gateway](https://www.braintrust.dev/docs/deploy/gateway).

**Design recommendation:** Calling one OpenAI-compatible endpoint is not gateway parity. A replacement needs provider-specific parameter handling, streaming, authentication, rate-limit behavior, fallback policy, cache isolation, usage accounting, and failure tests. Keep provider keys server-side. Disable result caching when measuring model nondeterminism or clearly mark cached trials.

### Loop, Topics, and Patterns

**Documented:** Loop investigates project data, authors or edits scorers/prompts/datasets, runs experiments, and creates dashboards; object changes have approval flows. Topics classifies production traces; Patterns investigates recurring problems and suggests fixes using scheduled Loop work. These are substantive existing features, not a vacant category for MindTrust. [Loop](https://www.braintrust.dev/docs/loop/capabilities), [Topics](https://www.braintrust.dev/docs/observe/topics), [Patterns](https://www.braintrust.dev/docs/observe/patterns).

**Design recommendation:** Leave unsupported autonomous capabilities out of the first UI, or identify them as roadmap items. Do not substitute fixed canned responses for an investigation agent.

### Enterprise operations

**Documented:** Braintrust offers organization/project/object access controls, service accounts, SSO/SCIM-related administration, retention, auditability, and deployment options. Permission grants are additive and some scope controls are Enterprise features. Deployment options include SaaS, BYOC, and a self-hosted data plane. Self-hosting the data plane does not mean replacing the vendor-operated control plane. [Access control](https://www.braintrust.dev/docs/admin/access-control), [administration](https://www.braintrust.dev/docs/admin), [deployment](https://www.braintrust.dev/docs/admin/deployment).

**Design recommendation:** A localhost application with a shared API key is not a multitenant enterprise service. Separate commercial readiness from feature completeness.

## 3. Public conceptual model and API behavior

This is a conceptual reconstruction, not Braintrust's private relational schema.

- An **organization** holds members, provider configuration, and permissions.
- A **project** groups logs, experiments, datasets, prompts, evaluators, and configuration.
- A **dataset** has records and revisions. An **experiment** records the dataset and dataset version used, plus configuration and execution evidence.
- An **event row** carries JSON input/output/expected data, metadata, scores, metrics, errors, and provenance. Distinct `id`, `span_id`, `root_span_id`, and `span_parents` fields encode storage identity and trace relationships.
- A **prompt/function** is a versioned object; environments select versions.
- **Feedback** targets an existing row and carries reviewer/source information independently of the original task result.

The published OpenAPI uses resource operations plus event `insert`, `fetch`, and `feedback` endpoints for logs, experiments, and datasets. Event updates distinguish replacement from deep merge, support merge-path controls, and allow tombstones. Consequently, accepting one representative payload is not drop-in SDK compatibility. The current public specification contains 75 path entries; this is a research snapshot, not a completeness guarantee for every live service. [Public OpenAPI specification](https://github.com/braintrustdata/braintrust-openapi/blob/main/openapi/spec.json), [API introduction](https://www.braintrust.dev/docs/api-reference).

Representative public entry points include:

- `POST /v1/project_logs/{project_id}/insert`
- `POST /v1/experiment/{experiment_id}/insert`
- `POST /v1/dataset/{dataset_id}/insert`
- Corresponding `/fetch` and `/feedback` routes
- `POST /btql`
- `POST /otel/v1/traces`
- `POST /otel/v1/logs`

**Design recommendation:** Use a small, explicit MindTrust API first. Treat Braintrust JSON import as a migration adapter with documented field coverage. Add protocol compatibility only against a pinned upstream SDK version and contract fixtures.

### SDK behavior to preserve or explicitly adapt

**Documented:** The TypeScript surface includes `initLogger` for production logging, `wrapTraced` and manual spans for nesting, `initDataset` for data access, `Eval` for task/scorer execution, and experiment objects with logging, feedback, flushing, fetching, and summaries. Prompt loading/invocation supports version selection. The public SDK exposes convenience objects over the service rather than merely serializing a single trace schema. [TypeScript reference](https://www.braintrust.dev/docs/reference/libs/nodejs), [JavaScript SDK](https://github.com/braintrustdata/braintrust-sdk-javascript).

**Design recommendation:** Provide an intentionally smaller client with explicit project selection, batching, errors, and shutdown flushing. Test concurrent nested tracing and promise rejection. Document differences in naming, execution ownership, and comparison matching. Do not recommend changing only `BRAINTRUST_API_URL` until the upstream SDK's login, discovery, upload, fetch, and error-handling paths have been exercised against MindTrust.

## 4. What the published architecture explains

**Documented:** Braintrust separates a managed control plane from a data plane. Its published self-hosted architecture uses TypeScript/Node API services, PostgreSQL metadata, Redis coordination, object storage, and Brainstore. Brainstore uses a Rust query/ingestion engine, durable object-storage write-ahead entries, asynchronous indexing, and separate writer, reader, and fast-reader roles. Readers can combine recent writes with indexed data rather than waiting for compaction. [Architecture](https://www.braintrust.dev/docs/admin/self-hosting/architecture).

**Inference:** This separation helps explain why matching page layouts would leave the difficult scale and reliability work untouched. Trace payloads are large, nested, frequently updated, and queried interactively while ingestion continues. A single-process relational implementation can be an excellent starting point; its throughput, retention, durability, and concurrency limits must be measured independently.

## 5. Independent MindTrust design direction

These are proposed choices, not claimed Braintrust internals or achieved differentiators:

1. **Shared evidence objects.** Reuse one typed event model across production and evaluation, with origin links into datasets.
2. **Immutable manifests.** An experiment records dataset revision, prompt revision, scorer definitions, target/model configuration, concurrency, and seed where supported.
3. **Explicit execution states.** Queued, running, completed, cancelled, failed, and partially completed remain distinguishable; individual errors stay inspectable.
4. **Bounded execution.** A worker scheduler limits concurrent model/scorer tasks and applies timeouts. Provider rate limits should decrease useful concurrency rather than multiply retries.
5. **Credible comparisons.** Match stable examples, compare identical score definitions, retain unmatched/error rows, and show distributions as well as averages.
6. **Portable data.** Import and export JSON without losing metadata, expected values, annotations, hierarchy, or source IDs. Keep adapters separate from the core model.
7. **Low operational overhead.** Begin with a simple local deployment and deterministic tests; add distributed ingestion, object storage, and workers when measured workloads justify them.

The first release should make one production failure become a repeatable regression test with minimal manual work. That is a coherent product slice even before advanced provider routing and enterprise controls exist.

## 6. Parity acceptance tests

These tests define observable behavior, not requirements to copy implementation details:

- **Persistence:** Create a project, add traces, datasets, prompts, and an experiment; restart the service; verify exact recovery.
- **Trace ingestion:** Send nested and out-of-order spans. Repeat a batch. Verify no duplicate rows and intact parent relationships. Exercise malformed timestamps and unknown attributes.
- **Cost accounting:** Combine parent and child usage; ensure totals count each billable operation once. Unknown cost stays unknown. Currency and pricing version are explicit.
- **Dataset revisions:** Run against revision A, edit/delete cases to create B, rerun A, and prove the original cases and expectations remain available.
- **Execution:** Execute a real user-defined task or configured provider, limit concurrency, capture task/scorer errors, and preserve completed results after a failure.
- **Comparison:** Reorder cases, add/remove cases, change a scorer, and omit a score. Verify alignment and that absent values never become fabricated improvements.
- **Prompt provenance:** Edit a prompt after a run; old results retain the exact prompt/configuration. Missing variables fail clearly.
- **Annotations:** Multiple updates preserve reviewer/source provenance and cannot silently alter automated scores or historical expectations.
- **Migration:** Import exported records, export again, and compare IDs, hierarchy, values, metadata, and annotations field by field.
- **Boundary enforcement:** Reject unauthorized requests, oversize payloads, malformed JSON, cross-project references, and unsafe URLs when applicable.

## 7. Migration strategy

**Documented:** Braintrust exports annotated data, including tags, expected values, scores, and metadata. The query API documents JSON, JSONL, and Parquet formats and cursor-based pagination. Export support makes migration feasible; it does not automatically migrate configurations or preserve every runtime behavior. [Annotated exports](https://www.braintrust.dev/docs/annotate/export), [query API](https://www.braintrust.dev/docs/api-reference/query).

**Design recommendation:** Migrate in stages: inventory active datasets/scorers/prompts and consumers; import records with original IDs; validate counts and content hashes; dual-write telemetry; replay the same evaluation workloads; compare outcomes, cost, and latency; only then move alerting and review workflows. Keep a rollback path. Do not retire Braintrust while downstream teams still depend on unsupported features.

## 8. Cheaper and faster: evidence required

**Documented pricing snapshot:** Starter is $0/month with included usage; Pro is $249/month with included processed data, scores, and model credits plus usage charges. Enterprise pricing is custom. The pricing page separates processed data, scores, model usage, and retention. A public self-service price is not a reliable estimate of an enterprise customer's bill. [Pricing](https://www.braintrust.dev/pricing).

**Proposed benchmark:** Use identical tasks, examples, scorer definitions, model settings, provider accounts, cache conditions, concurrency budgets, and retention. Measure ingestion acceptance latency and query visibility separately; report trace-open latency and filtered-query latency under concurrent writes. For evaluations, measure total wall time, provider tokens/cost, infrastructure cost, retries, failed jobs, and human maintenance time. Run both cold and warm workloads.

Publish hardware, dataset sizes, payload distribution, sample counts, p50/p95 results, and error rates. Compare quality and disagreement rates as well as speed. Local zero-provider demo runs cannot substantiate a claim that MindTrust is cheaper or faster than Braintrust. Deterministic grading, selective execution, and caching are optimization hypotheses until independently validated against equivalent outcomes.

## 9. Required first-release disclosures

The delivered app must state its actual limitations, including each item that remains unsupported:

- Scope of SDK and API compatibility; supported import/export fields and dropped fields.
- Exact OTLP signals, transports, encodings, and semantic conventions accepted.
- Live provider integrations versus clearly labeled fixture/demo execution.
- Whether experiments survive crashes and resume; whether cancellation actually stops work.
- Whether scorer code executes locally, remotely, or in a hardened sandbox.
- Supported prompt templating, streaming, gateway routing, caching, and credential handling.
- Team authentication, authorization, tenant isolation, audit logs, retention, backups, and recovery.
- Human review assignment, reviewer independence, online scoring, alerts, Topics, and Loop equivalents.
- Supported scale and any measured performance; no untested SLA, compliance, or enterprise-readiness claims.

## 10. Source and implementation boundary

Braintrust's public JavaScript SDK and OpenAPI repositories declare Apache-2.0 licenses. This research inspects their public interfaces; the MindTrust implementation is intended to be independently authored. Any future reuse of licensed source must retain the applicable license/notice obligations and be tracked explicitly. This document does not apply Braintrust's SDK license to Braintrust's website, branding, private services, or MindTrust's original code. [SDK license](https://github.com/braintrustdata/braintrust-sdk-javascript/blob/main/LICENSE), [OpenAPI repository](https://github.com/braintrustdata/braintrust-openapi).

No Braintrust customer account, private endpoint, proprietary server code, or customer dataset was accessed for this research. Public documentation can change; pin source revisions and SDK versions before making compatibility promises.
