# Braintrust SDK compatibility

Verified October 11, 2026. MindTrust implements a bounded compatibility API, with real HTTP contracts against **JavaScript `braintrust@3.37.2`** and **Python `braintrust==0.45.0`**. These packages run unmodified. This is evidence for the workflows below, not a claim of full Braintrust parity or support for every SDK release.

The upstream packages and public source are the protocol references: [JavaScript package](https://www.npmjs.com/package/braintrust/v/3.37.2), [JavaScript source](https://github.com/braintrustdata/braintrust-sdk-javascript), [Python package](https://pypi.org/project/braintrust/0.45.0/), and [Python source](https://github.com/braintrustdata/braintrust-sdk-python). MindTrust's adapter was implemented independently; it does not contain copied Braintrust implementation code.

## Configure an existing application

Create a MindTrust project and issue an editor API key scoped to that project under **Team access**. Use a fresh key, not a Braintrust service key. A scoped key can work in an existing project; only an administrator can create a new project through the compatibility API.

Set both URLs to the same MindTrust origin:

```sh
export BRAINTRUST_APP_URL=http://127.0.0.1:4310
export BRAINTRUST_API_URL=http://127.0.0.1:4310
export BRAINTRUST_ORG_NAME=MindTrust
export BRAINTRUST_API_KEY='<MindTrust API key>'
```

Use HTTPS for a shared deployment, and set its server-side `MINDTRUST_PUBLIC_URL` to the externally reachable origin. The login response advertises that origin. Remove any explicit cloud `appUrl` / `app_url` overrides in the application. Do not put keys in source control or browser code.

The task and scorer code remains in the client process. For example:

```ts
import { initLogger, wrapTraced } from 'braintrust';

const logger = initLogger({ projectName: 'My MindTrust project' });
const task = wrapTraced(async (input: string) => input.toUpperCase(), {
  name: 'uppercase',
});
await task('synthetic input');
await logger.flush();
```

```python
import braintrust

logger = braintrust.init_logger(project="My MindTrust project")

@braintrust.traced(name="uppercase")
def task(input):
    return input.upper()

task("synthetic input")
logger.flush()
```

Names and IDs refer to **MindTrust resources**. A cloud Braintrust project, dataset, or experiment ID will not automatically resolve locally. Global wrappers use the SDK's normal current logger; independent internal SDK state objects are not an advertised configuration. SDK experiment-summary links of the form `/app/MindTrust/p/<project-name>/experiments/<experiment-name>` resolve after sign-in when an accessible project and experiment match uniquely. Missing or ambiguous names show an error. Other SDK-generated dataset/log links remain unsupported; navigate to those resources through MindTrust.

## Tested workflows

- **Tracing:** `initLogger` / `init_logger`, `wrapTraced` / `traced`, concurrent nested spans, outputs, errors, flush, score feedback and comments. Hierarchy is preserved; native trace IDs are namespaced to avoid cross-project/source collisions. Original row/span identifiers remain in raw exports and source metadata.
- **Datasets:** `initDataset` / `init_dataset`, insertion, deep metadata updates, tag union, deletion, paginated reads, dataset-ID lookup, summaries and pinned revision reads. An absent `expected` stays absent on the raw API. The JavaScript reader presents it as `undefined`; the pinned Python SDK sends `expected: null` when its insert argument is omitted, so that distinction cannot be recovered from Python's wire request.
- **Evaluation:** `Eval` executes real client-side tasks and scorers, supports concurrent cases, records native cases and scores, and retains the dataset revision used by the run. Repeated trials are 1-based in native records; equal inputs with different expected values have distinct case identities. The adapter collects successful scores from the current SDK's scorer spans as well as scores on the evaluation root.
- **Migration primitives:** JSON event insert, paginated raw fetch, and trace/experiment score-and-comment feedback use the same authorization and transactional validation as SDK ingestion. Unknown ordinary JSON columns are retained in raw rows rather than silently dropped.

JavaScript contracts also prove all-or-nothing mixed-project batches, denied writes for viewers, idempotent replay, explicit unsupported-feature errors, raw-only dataset revision changes, and that adding a trace does not rewrite unrelated historical traces. Python contracts use the full application, including its authentication middleware.

## Storage and provenance

A `/logs3` batch is committed atomically after every target's permissions are checked. Replaying the same final row content does not create a second case or dataset revision. Object merges recurse; arrays replace; top-level tags union unless explicitly replaced through `_merge_paths`. Unknown underscore-prefixed control fields fail with `501`. A 5 MB HTTP body limit and 10,000-row batch limit apply; a server error must not be treated as a successful flush.

Dataset revisions are immutable native snapshots. Raw-column changes also advance the revision. Edits made through the native dataset API are reconciled on the next compatibility write: canonical input/expected/metadata/tags follow the native revision, and extra raw columns survive for row IDs still present. Raw fetch returns the local, zero-padded dataset revision in `_xact_id`; it does **not** claim to retain a cloud Braintrust transaction history. Original submitted events, including any source `_xact_id`, are retained internally in the adapter's event journal.

SDK evaluations are marked `executionSource: sdk-import` with an external task. The server does not pretend to possess the original task or scorer implementation. A linked dataset is pinned at registration; rows that contradict its input or ground truth are rejected. Inline-data evaluations collect their input manifest as roots arrive, so they are not a server-frozen manifest created before the client runs. Trial numbers are assigned in ingestion order for an identical complete case; they do not attest to an upstream SDK trial index.

An experiment becomes completed after its summary is requested and every observed root has an end timestamp. If a client crashes before flushing all expected cases, the server has no complete client execution manifest with which to prove that missing cases exist. Reproducibility therefore still requires retaining your task, scorer code, dependencies and dataset revision.

Raw trace fetches use indexed, bounded SQL reads. A cursor is bound to its object and revision; concurrent writes cause `409` rather than silently skipping or duplicating rows. Restart the fetch, or use an explicit dataset version. A full raw dataset snapshot remains a JSON snapshot in SQLite, rather than a distributed analytical store.

## Export and import a dataset

First export from the source with its official SDK/API. Keep that original file unchanged. For a JSON/JSONL export, parse records as objects and prepare a copy for import:

1. Retain each record's `id`, `input`, `expected` if present, metadata, tags and ordinary extra columns.
2. Record the source dataset ID and source `_xact_id` in ordinary fields such as `source_dataset_id` and `source_xact_id`. Remove the old container ID and `_xact_id` before submission. This makes provenance available on subsequent exports instead of confusing a source transaction with a local revision.
3. Create a destination with `POST /v1/dataset` and `{ "project_id": "<MindTrust project ID>", "name": "import name" }`.
4. Send batches to `POST /v1/dataset/<id>/insert` as `{ "events": [...] }`. Existing identical IDs/content can be retried safely. A different full event with the same ID replaces that event; use `_is_merge: true` only when merge semantics are intended.
5. Read `GET /v1/dataset/<id>/fetch?limit=1000` and follow its `cursor`. Compare IDs, counts, input, expected presence/value, metadata, tags and retained source columns with the prepared export. Keep both the original and verification results until migration is accepted.

Do not rewrite an entire experiment's container ID and assume its provenance is valid: dataset origins, pinned local revision and baseline references must also be mapped. The implemented path for a portable run is to import a dataset and rerun the retained client task/scorers against it. Historical experiment events are supported only when those references can be truthfully resolved.

## Deliberate limits

These features fail explicitly or are outside the tested surface:

- Arbitrary SQL/BTQL, filters, projections and aggregations. `/btql` accepts only the official object-reader `select *` AST for one dataset, experiment or project log, with pagination.
- Hosted functions, prompt/parameter registries, playground execution, deployment environments and dataset snapshots distinct from native versioned datasets; no implicit execution of imported code.
- Attachment references/uploads, overflow uploads, gateway/proxy routing, SDK integrations that need additional server endpoints, project groups and public sharing.
- Automatic baseline selection and server-side baseline comparison summaries. A requested comparison returns `501`; a simple summary is only that run's own means. MindTrust native comparisons retain their own provenance warnings.
- Trace or experiment row deletion, moving an existing row to another root/span identity, multiple span parents, `_array_delete`, and changes to an existing experiment's linked dataset. Dataset row deletion is supported and retains historical snapshots.
- More than 10 trials per complete case. The standard SDK registration does not send a total trial count, so an oversized run is rejected when the eleventh distinct root for a case reaches ingestion; already committed earlier batches remain. Prefer setting `trialCount` / `trial_count` to 10 or lower before running.
- Dataset comments through the compatibility feedback endpoint and feedback that changes pinned experiment ground truth. Use a new dataset revision and evaluation for corrected ground truth.
- Unknown score provenance: a scalar value is not proof of its scorer definition. Importing a score name does not create a verified native scorer or establish that two runs are comparable.

The upstream SDKs can catch summary errors or retry/drop failed log batches. The contract tests check HTTP outcomes and resulting stored data in addition to SDK return values. Operators should monitor rejected ingestion and use explicit flush/error handling. Do not infer that a resolved application task means its telemetry was durably accepted.

## Reproduce the contracts

Use Node 24 and Python 3.12. These checks use only synthetic inputs, local tasks and an ephemeral authenticated MindTrust instance; no Braintrust account, API key or LLM provider is required.

```sh
npm ci
npx tsx --test tests/braintrust-compat.test.ts
python -m pip install -r tests/contracts/requirements.txt
python -m unittest discover -s tests/contracts -p '*_test.py' -v
```

The Python harness blocks requests to other origins. The JavaScript harness similarly restricts SDK fetch calls to its local fixture. CI pins both upstream SDK versions; upgrade either dependency only alongside these contracts. Passing them demonstrates the named workflows, not throughput or cost superiority over Braintrust.
