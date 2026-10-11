# Moving an evaluation workflow into MindTrust

Start with a workflow that uses traces, dataset records, deterministic or client-side scorers, and experiments. Keep Braintrust available until results and operational behavior are verified.

1. **Inventory dependencies.** List active projects, datasets, scorers, prompt versions, integrations, review workflows, and alert/query consumers. Check the limitations in `architecture.md` before committing to a switch.
2. **Export data using Braintrust's documented tools.** The current dataset importer accepts JSON arrays with `id` (or `_id`), `input`, `expected`, `metadata`, and `tags`. JSONL must first be converted to an array. Do not assume raw trace/experiment dumps can be sent to the dataset importer without transformation.
3. **Create a MindTrust project and dataset.** Import in the Datasets page or send `{ "rows": [...] }` to `POST /api/datasets/:id/import`. Imports append/upsert stable IDs and create a new dataset revision. Review counts and values after import.
4. **Recreate scorers and tasks deliberately.** Server-side built-ins cover exact match, containment, and valid JSON; application-specific scorers run locally through the Node SDK. Braintrust Autoevals, hosted code, judge configuration, and classifiers are not automatically migrated.
5. **Run the same cases in both systems.** Freeze model parameters, prompt text, scorer definitions, retry policy, environment, concurrency, and dataset. Review errors and missing scores before comparing averages. MindTrust pairs by stable row ID plus trial rather than identical input.
6. **Instrument and dual-write.** Adopt the MindTrust SDK or OTLP/HTTP JSON receiver. Verify parentage, timestamps, metadata, and token/cost fields on representative real traces. Do not merely change `BRAINTRUST_API_URL`; the Braintrust SDK wire protocol is not supported.
7. **Verify recovery and operations.** Test backup/restore, authentication, key revocation, process restarts, cancellation, missing providers, and malformed data. Keep a documented rollback route before retiring an existing service.

## Example dataset import

```json
[
  {
    "id": "case-001",
    "input": { "request": "Check order status" },
    "expected": { "status": "shipped" },
    "metadata": { "source": "braintrust-export", "sourceDataset": "order-regression" },
    "tags": ["regression"]
  }
]
```

The importer maps these record fields; it does not migrate the upstream revision graph, permissions, comments, attachments, or environments. Preserve the original exports separately. MindTrust annotations and experiment imports use their own API shapes in `api-contract.md`.

## Performance comparison

Measure accepted/visible ingestion latency, query latency under concurrent writes, trace-open latency, total evaluation wall time, provider usage, infrastructure cost, failed jobs, retries, and maintenance effort. Use identical workloads and report quality disagreements. A fast local demo does not establish a cost or speed advantage over Braintrust.

Public references: [Braintrust export documentation](https://www.braintrust.dev/docs/annotate/export), [experiment comparison](https://www.braintrust.dev/docs/evaluate/compare-experiments), [OTLP ingestion](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry/send-traces-and-logs).
