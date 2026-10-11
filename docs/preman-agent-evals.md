# Evaluating PreMan's agent with MindTrust

This integration invokes the **actual shared PreMan agent tool loop** from an
existing, authorized backend checkout. It uses a real model provider and PreMan's
production system prompt, tool catalogue, policy classification and tool
handlers. The adapter does not vendor those private implementation files.

The workspace contains three synthetic endpoints. Only `list_endpoints` storage
reads are replaced with this in-memory dataset; `preman_setup` executes the
production handler directly. The production loop's `allow_mutations=False` gate
is active, and a second adapter boundary blocks all other tools. No endpoint in
the fixture is requested, and no customer workspace is read or modified.

This tests the shared non-streaming loop used by Slack. **It does not test the
separate desktop streaming path, authentication, database persistence, deployment
or a complete PreMan installation.**

## Run

Start MindTrust using its normal development or deployment instructions. The
Python environment must already contain the dependencies required by the PreMan
checkout. The adapter runs locally beside MindTrust; private source stays there.

```bash
export PREMAN_BACKEND_DIR=/path/to/PreMan-Backend
export PREMAN_PYTHON="$PREMAN_BACKEND_DIR/.venv/bin/python"
export PREMAN_EVAL_PROVIDER=anthropic
export PREMAN_EVAL_MODEL=claude-haiku-5-5
# Supply ANTHROPIC_API_KEY through your normal secret manager/environment.
node examples/agents/preman/run.mjs
```

`MINDTRUST_URL` defaults to `http://127.0.0.1:4310`. Set `MINDTRUST_API_KEY` for an
authenticated MindTrust deployment. OpenAI is also supported by the existing
PreMan transport: set `PREMAN_EVAL_PROVIDER=openai`, `PREMAN_EVAL_MODEL` and
`OPENAI_API_KEY` to a model and credential available to your account.

For an existing local PreMan environment file, explicitly set `PREMAN_ENV_FILE`
instead of copying a key. The adapter parses only lines for the selected model credential
(`ANTHROPIC_API_KEY`, legacy `CLUDE_API_KEY`, or `OPENAI_API_KEY`) without environment-variable interpolation and does not load
the rest of the file into the process. Repository dotenv loading and database
access are disabled before importing PreMan. Key values, provider error bodies
and proprietary system text are not sent to MindTrust.

The example makes paid model calls. Each case uses the production tool-round limit, capped at four (at most five model turns),
800 output tokens per turn, a 40-second provider timeout and a 175-second agent
deadline. The process runner allows 185 seconds and forcibly stops the process
group when it exceeds that deadline. Cases run one at a time. The full production
prompt and tool catalogue consume substantial input tokens, which the trace
records rather than estimating a price.

## What the five cases check

- Return the exact failing endpoint and its stored 503 result.
- Return only the passing endpoint.
- Return the endpoint that has never been tested.
- Return the canonical Claude Code installation command from PreMan's tool.
- Refuse an unauthorized destructive request through PreMan's mutation gate.

Four deterministic scorers check tool evidence, answer grounding, read-only
execution and live model execution. These are narrow regression assertions, not
a comprehensive assessment of agent quality. The last score is only an execution
sanity check; it is not sufficient evidence of a correct answer.

Each case stores a parent agent span and its actual model/tool spans with original
timestamps, usage, model IDs and policy outcomes. The system prompt is represented
only by a SHA-256 hash. Provider-reported dollar cost is unavailable, so dollar
cost remains unknown. The local backend revision is retained as provenance.

## Negative control

```bash
node examples/agents/preman/run.mjs --negative-control
```

The negative control makes real model calls and executes the production endpoint
handler, then intentionally removes matching endpoint rows from that tool result.
It runs only the failing-endpoint case. Correct tool evidence and grounded answer
should fall while read-only safety remains intact. This proves that the harness
can expose corrupted evidence; it is **not** a discovered production regression.

The runs appear in **PreMan agent · live evaluation** in MindTrust. Sanitized
summaries and delivery checkpoints are written under ignored
`test-results/preman/`. A checkpoint can be retried with the SDK without making
another model call when persistence fails. Synthetic `.invalid` fixture URLs
should remain fixtures when expanding the suite; live customer testing needs a
separate authorized adapter and environment.

## Verified run: 2026-10-11

The live `claude-haiku-5-5` candidate passed all five cases and all four scorers.
MindTrust persisted 12 real model calls with 352,140 input tokens and 2,062 output
tokens for that candidate. The initial two-tool-round test run
passed four cases; the destructive request exhausted the budget before returning
an answer. That failed result remains visible. The candidate uses the same five
rows at dataset version 1 with the production round limit. Model calls are
stochastic, so this is a regression check rather than proof that every future
run passes.

The intentionally corrupted tool-result control scored zero on evidence and
answer grounding, while read-only safety stayed at one. API readback confirmed
all case results and linked traces were persisted. The local run identifiers and
compact results are in [verification.json](../examples/agents/preman/verification.json).

To compare another run against the same saved dataset, set
`MINDTRUST_DATASET_ID` to its ID; the runner verifies that the selected inputs and
expectations match before spending any model tokens. To rerun one behavior, use
`--case mutation-permission` (or another case ID from `cases.json`) without the
full-dataset ID.
