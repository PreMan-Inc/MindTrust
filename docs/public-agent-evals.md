# Public agent evaluations

MindTrust runs real agent code in the caller's Python process and stores the evaluation dataset, cases, model/tool traces and scores. The examples use the unmodified, pinned **Braintrust Python SDK 0.45.0** against MindTrust's compatibility API. No Braintrust service or Braintrust account is used.

The three implementations exercise different public orchestration libraries:

- **LangGraph 1.2.1:** an explicit `StateGraph` alternates between a model node and a tool node until the model returns its decision.
- **PydanticAI 1.100.0:** a typed agent uses registered Python tools and validates a structured `Decision` output.
- **smolagents 1.22.0:** `ToolCallingAgent` chooses structured tool calls and terminates through its final-answer tool. It has no code execution or shell tool.

These are MindTrust-authored integration agents using upstream libraries and their documented agent patterns. They do not claim to validate every upstream example, every framework feature, or an existing customer's production agent. Upstream repositories, pinned commit IDs, licenses, inspected source files and their SHA-256 hashes are in [`upstream.json`](../examples/agents/public/upstream.json). Dependency versions, including transitive dependencies, are in `requirements.lock.txt`.

## What the agents do

Each agent decides whether a synthetic service can be released. It fetches observed request/error/latency measurements, fetches that service's release policy, calls an error-rate calculation tool, and chooses `release`, `block` or `needs_review`. The four saved cases cover a failed error budget, a healthy service, a service-specific policy and an unknown service.

The expectations are hand-authored and withheld from the model. Three independent scorers check the final decision, numeric rate and whether the tool calls were grounded in the requested service and measured counts. All three implementations evaluate the same saved dataset version.

A fourth experiment changes the calculator's units from percent to fraction while keeping the rest of the real agent unchanged. This is a deliberate regression, not a mock model: the model still makes live requests and tool decisions. Its experiment references the baseline so the incorrect units and downstream release decisions can be compared in MindTrust.

## Run it

Start MindTrust first, then from the repository root:

```sh
uv venv --python 3.12 examples/agents/public/.venv
uv pip install --python examples/agents/public/.venv/bin/python -r examples/agents/public/requirements.lock.txt
export ANTHROPIC_API_KEY='your-provider-key'
examples/agents/public/.venv/bin/python examples/agents/public/run.py
```

The default is Anthropic `claude-haiku-5-5`. OpenAI can be selected explicitly with `--provider openai --model <tool-capable-model>` and `OPENAI_API_KEY`; that path is implemented but was not verified with a live OpenAI key in this run. `--env-file /path/to/local.env` reads the selected credential without executing the file. The legacy `CLUDE_API_KEY` name is accepted only for the Anthropic option.

`MINDTRUST_URL` defaults to `http://127.0.0.1:4310`. For an authenticated server, set `MINDTRUST_API_KEY` to a key authorized for the chosen existing project, and pass `--project 'Project name'`. For an unauthenticated local development server, the runner creates a dedicated project and a temporary editor key scoped to it. The key stays in process memory, expires in two hours, and is revoked when the runner exits. Provider secrets never enter the dataset, trace metadata or result report.

Useful options:

```sh
# Run one framework and its deliberate regression control.
examples/agents/public/.venv/bin/python examples/agents/public/run.py --framework langgraph

# Write a separate evidence report and omit the regression control.
examples/agents/public/.venv/bin/python examples/agents/public/run.py --no-control --report /tmp/agent-evals.json
```

The runner pins the dataset version, executes each case, flushes the SDK, then reads MindTrust's API back to verify that all cases and model/tool spans were stored. It exits nonzero for task errors or a failing baseline. A successful control run is expected to have failing quality scores; the runner fails if the units regression goes undetected.

## Verified run

The 11 October 2026 suite persisted in project `460dea97-b402-48cd-990a-4dee41b41a6b`:

- All twelve baseline cases across the three frameworks scored 100% on decision correctness, numeric rate and grounded tool use.
- The four-case units regression produced two changed decisions and three incorrect rates. The unchanged missing-service case still passed. This is evidence that the scorers detected a real agent/tool regression, not just successful API calls.
- The suite recorded 45 model spans, 45 tool spans, 66,845 input tokens and 6,405 output tokens reported by the provider. Model latency was recorded in each case and in the experiment summary.
- A separate four-case PydanticAI verification after disabling provider SDK retries and closing its async client also passed all three scorers.

The first LangGraph attempt failed all four cases because the selected Anthropic model rejected the `temperature` parameter. Removing the unsupported option fixed the integration. A second gap surfaced after inference: Braintrust's SDK requested a comparison summary that MindTrust returned as unsupported, leaving the imported control run marked running. MindTrust's comparison endpoint was extended with aligned-case contracts and the existing run was successfully summarized through the official Python SDK, without rerunning the model. Both findings remain in the evidence report; they are not counted as successful agent evaluations.

## Bounds and evidence

Only synthetic data is sent to the model. The three tools read local constants or perform arithmetic. There are no tools that can write files, call arbitrary URLs, send email, deploy or access customer systems. Each case is limited to six model requests, twelve tool calls and 800 output tokens per model request, with a 45-second provider timeout. Evaluations run with concurrency one. The SDK evaluation timeout is 300 seconds; running calls are additionally bounded by the provider timeout and request budget.

[`latest-results.json`](../examples/agents/public/latest-results.json) records the real run, package versions, dataset version, experiment IDs, individual outcomes, scores, provider-reported token counts and wall-clock duration. Dollar cost is deliberately `null`: no account-specific invoice or pricing calculation was available. It must not be presented as free inference.

These are small functional integration checks, not a benchmark of model quality, throughput, fleet reliability or full Braintrust compatibility. Prompt- and model-dependent output can change on reruns. Use customer-specific datasets, permissions and concurrency limits before evaluating a production workload.

Primary references: [LangGraph quickstart](https://docs.langchain.com/oss/python/langgraph/quickstart), [PydanticAI agents](https://ai.pydantic.dev/agents/), [smolagents agents](https://huggingface.co/docs/smolagents/reference/agents), [Anthropic integration](https://docs.langchain.com/oss/python/integrations/chat/anthropic).
