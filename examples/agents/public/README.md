# Real public-framework agents

See [the runnable guide](../../../docs/public-agent-evals.md) for setup, scope and evidence.

- `run.py`: official Braintrust SDK → MindTrust eval runner and round-trip verification.
- `common.py`: synthetic cases, bounded tools and independent scorers.
- `langgraph_agent.py`, `pydantic_agent.py`, `smolagents_agent.py`: real model/tool agents.
- `upstream.json`: pinned upstream refs and inspected source hashes.
- `requirements.lock.txt`: the tested Python 3.12 environment.
- `latest-results.json`: the actual model-run evidence, with no credentials.

No generated code execution, real customer data, outbound tool actions, or provider dollars inferred from token counts.
