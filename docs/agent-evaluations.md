# Evaluating real agents

MindTrust executes agent evaluations through a runner in your application environment. The runner calls the real model and tools, scores each result against a versioned dataset, and persists the experiment and nested traces in MindTrust. No agent source code or provider credential needs to be uploaded to the MindTrust server.

Open **Integrations → Agent evals** for a project-specific starter. Use **Experiments** to inspect results and compare two runs on the same dataset revision; open a case's trace to see model decisions and tool outputs.

## Run the verified integrations

- [PreMan shared agent loop](preman-agent-evals.md): uses an authorized local PreMan checkout, its production loop, tool definitions, policy gate and read-only handlers, with synthetic workspace storage. The private implementation and system prompt remain outside this public repository.
- [Public framework agents](public-agent-evals.md): LangGraph, PydanticAI and smolagents run real model/tool loops and log through the official Python Braintrust SDK redirected to MindTrust. Upstream versions, commits and source references are pinned in `examples/agents/public/upstream.json`.

These are bounded integration tests, not general intelligence benchmarks or full production application tests. The example tools use synthetic data. Provider tokens come from actual responses; dollar costs remain unknown. Negative controls deliberately break tool results to verify that the scorers detect regressions.

## Native JavaScript agent

```js
import { MindTrust } from '../sdk/index.mjs';
import { runAgent } from './your-agent.mjs';

const client = new MindTrust({
  baseUrl: process.env.MINDTRUST_URL ?? 'http://127.0.0.1:4310',
  apiKey: process.env.MINDTRUST_API_KEY,
  projectId: '<existing-project-id>',
});

await client.evaluate({
  name: 'Agent regression v2',
  datasetId: '<existing-dataset-id>',
  datasetVersion: 1,
  concurrency: 2,
  caseTimeoutMs: 120_000,
  scorerTimeoutMs: 30_000,
  task: (input, { signal, span }) => runAgent(input, { signal, span }),
  scorers: [
    {
      name: 'Expected outcome',
      score: ({ output, expected }) => Number(output.outcome === expected.outcome),
    },
  ],
});
```

Use `span.trace(name, {kind: 'llm' | 'tool', input}, callback)` around actual operations. Update model, inputTokens and outputTokens from the provider response. Scorers also receive a span and abort signal, so a model judge can record its own usage under the case.

In-process deadlines are cooperative: pass the supplied signal through model requests and tools. JavaScript cannot forcibly stop a callback that ignores cancellation or blocks the event loop. The SDK freezes timed-out trace evidence so late results cannot overwrite the recorded failure. Use the process runner when a hard process boundary is needed.

## Python or another process

```js
import { processTask } from '../sdk/index.mjs';

const task = processTask({
  command: '/path/to/venv/bin/python',
  args: ['/path/to/agent_adapter.py'],
  cwd: '/path/to/agent-project',
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
  timeoutMs: 120_000,
  maxOutputBytes: 1_048_576,
});
// Pass task to client.evaluate(...).
```

The process receives one JSON request on stdin: `{input, metadata, trial}`. It returns one JSON object on stdout with required `output`, optional `error`, and optional `spans`. Send diagnostics to stderr. The combined stdout/stderr byte count is bounded; stderr is never copied into stored failure messages.

A completed span has a local `id`, optional local `parentId`, `name`, `kind`, `startTime`, `endTime`, and optional `input`, `output`, `metadata`, `model`, `inputTokens`, `outputTokens`, `costUsd`, `status`. Roots attach beneath the evaluation case. IDs are remapped, timestamps preserved, and the whole batch is validated before insertion. Duplicate IDs, orphan parents, cycles, invalid timing and invalid usage fail the case. A framework adapter can also call `span.addSpans(records)` directly.

The runner uses an executable and argument array, never a shell. Only basic operating system variables are inherited; pass needed credentials explicitly. Timeout or cancellation terminates the process group on POSIX, escalating to SIGKILL, and waits for closure. Windows terminates the direct child; descendant-tree termination has not been established there. This runs trusted code with your operating system permissions—it is not a sandbox for untrusted repositories.

## Failures, cancellation and delivery

- Task exceptions, process failures and deadlines remain case errors with null scores. Scorer failures stay separate from task failures. An all-error import is marked failed; a run aborted through its signal is marked cancelled. A score of zero is a measured failed expectation, not an infrastructure exception.
- A run pins the dataset revision at startup. Each case is a separate root trace, even if `evaluate()` is called inside other instrumentation. Trials and concurrency are bounded.
- Optional `onCheckpoint(payload)` runs serially before trace-batch delivery and again at completion. Save the payload in a private file; retry it with `client.importEvaluation(payload)` after a delivery failure. The checkpoint includes completed cases and undelivered traces, which are delivered before the import. The generated `runId` makes an identical import idempotent; different results under the same project/run ID return 409. Never rerun paid model calls merely to recover an import response.
- Trace delivery, checkpoint and final import failures after execution expose the payload as `error.result`. Interrupted checkpoints retain the planned case count, are marked failed on recovery and do not pretend that unstarted cases ran. Recovery imports completed work; it does not resume unstarted agent calls. Trace delivery must succeed before result import. Trace batches retain their IDs and can be retried with `flush()`.

The native runner imports the experiment after execution and flushes traces in bounded batches. It is not a durable remote worker scheduler: killing the host process mid-run requires an `onCheckpoint` file and explicit recovery; work since the last checkpoint can be lost. The browser cannot launch arbitrary local executables, and cancelling an imported completed experiment cannot reach an already-exited runner. Cancel active local work with its `AbortController`.

## Verification

`npm run check` includes real HTTP and subprocess contract tests without paid API calls. The separate live examples require credentials and intentionally incur bounded model usage. They are opt-in, never part of ordinary CI.

The runtime suite checks process-tree termination, malformed and oversized responses, per-case/scorer deadlines, cancellation, immutable timeout evidence, trace parentage and token accounting, import retry safety, and scorer rejection of deliberately wrong PreMan evidence. Refer to each example's report for the actual model, cases, failures and compatibility boundaries observed during live runs.
