# MindTrust

PreMan's effort to build a cheaper, faster alternative to Braintrust for agent evaluation and observability.

**Goal:** reduce the total cost and time required to evaluate agents without reducing failure detection.

## Status

This repository currently contains the initial product brief. The implementation, integrations, and performance benchmarks are not yet built or validated.

## Product direction

- **Efficient evaluations:** run independent cases in parallel with bounded concurrency, reproducible environments, and explicit resource budgets.
- **Trustworthy grading:** use executable checks for stable requirements and agent-assisted grading for cases that need judgment. Validate both against independently reviewed outcomes.
- **Useful debugging:** connect traces, tool calls, environment state, failures, and reproduction steps to each evaluation run.
- **Clear economics:** measure evaluation latency and the full cost of execution, grading, retries, environment setup, and human review. Keep unknown costs visible.
- **A practical migration path:** work toward importing Braintrust datasets and results, accepting OpenTelemetry traces, and comparing both systems before switching.

## First milestone

Build an evaluation runner and compare it with an existing Braintrust-based workflow on the same agent tasks and application artifacts.

1. Define a versioned task set, required assertions, and independently reviewed expected outcomes.
2. Establish the baseline with equivalent models, environments, resource limits, and confirmation rules.
3. Implement execution, grading, trace capture, and cost accounting for that task set.
4. Measure elapsed time, total cost, missed failures, false alarms, and reproducibility.
5. Publish the results and limitations before claiming a performance advantage.

Faster execution only counts if it preserves the agreed evaluation coverage and quality. Migration and broader observability features follow a demonstrated evaluation advantage.

## Initial scope

Start with agent evaluation and grading. Expand toward production observability, dataset management, experiment comparison, access controls, and operational reliability as the core workflow proves useful.

Technology choices and the implementation roadmap remain open.
