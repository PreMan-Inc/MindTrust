# Braintrust onboarding: observed behavior and comparison workflow

Source review: **October 10, 2026**. This review inspected public source and the official setup shell without executing the installer. The shell selected [Spark v0.0.17](https://github.com/braintrustdata/spark/releases/tag/v0.0.17) at review time. Behavior below refers to that release; an unpinned installer can change.

## What the official wizard does

- **Installs an executable.** The [setup shell](https://www.braintrust.dev/wizard/setup.sh) downloads the platform-specific Spark release, places `braintrust-setup` in `XDG_BIN_HOME` or `~/.local/bin`, and runs it in the current directory. It can replace an existing executable. The shell inspected did not verify a checksum or signature.
- **Authenticates through the browser.** It creates a wizard session, opens the returned login URL with a verification code, and polls with a separate token. Completion returns an API key and selected organization/project details. Organization and project identifiers alone are not authentication credentials. [Authentication source](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/auth.ts)
- **Writes local credentials before choosing an instrumentation mode.** It writes `.env.braintrust` and `.braintrust.json` with file mode `0600`, then adds them to `.gitignore`. The wizard does not remove these files when it finishes. [Credential handling](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/git.ts), [execution order](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/clack-wizard.ts)
- **Configures supporting tools.** It offers to install or update the `bt` CLI and configures its login and global project context. Before selecting an instrumentation mode, it discovers authenticated Claude Code/Codex installations and runs a short model smoke test. [CLI handling](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/braintrust-cli.ts), [coding-tool discovery](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/coding-tools/index.ts)
- **Can modify application code.** Built-in mode asks for confirmation, then launches the selected coding agent with permission bypass enabled. The prompt directs it to inspect the workspace, install the appropriate Braintrust SDK, and add tracing. The prompt says not to run application code; this is an instruction to the agent, not a technical execution boundary. Manual and own-agent modes avoid the built-in code edits, but not the earlier credential writes and tool checks. [Prompt](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/prompt.ts), [Codex adapter](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/coding-tools/codex.ts), [Claude adapter](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/coding-tools/claude.ts)
- **Sends setup telemetry.** Session creation starts before authentication. Defined event fields include CLI version, platform, architecture, launch source, agent type, repository state, tool availability, choices, outcomes, and durations. The inspected event payloads do not include source-file contents; no repository archive upload was found in the wizard. A selected coding agent processes workspace context separately, and an instrumented application sends traces when it runs. [Setup events](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/events.ts), [application tracing](https://www.braintrust.dev/docs/instrument/trace-application-logic)

No read-only or dry-run mode appears in the inspected [options](https://github.com/braintrustdata/spark/blob/v0.0.17/packages/spark/src/options.ts). The wizard is unnecessary for browser-only product inspection.

## Live UI checked, October 10, 2026

An authenticated empty-project UI exposed these controls:

- **Datasets:** Upload CSV/JSON or create an empty dataset. The empty-dataset modal asks for a name and provides a Create action.
- **Experiments:** Select a task, dataset, and scorers. Advanced settings expose metadata as YAML, trial count, maximum concurrency (displayed default: 10), and strict-variable validation that fails an evaluation when input omits a referenced variable.

No resource was created and no evaluation was run during this inspection. These observations confirm the presence of setup controls, not runtime semantics, feature parity, or performance. Account identifiers, private URLs, and screenshots are intentionally excluded.

## Recommended isolated comparison

This is a proposed workflow, not a completed benchmark:

1. Inspect the signed-in product through its UI first. Record which workflows are actually available; distinguish observed behavior from documentation and plan-dependent features.
2. If sample data is needed, use a disposable directory outside MindTrust and other application repositories. Create a dedicated comparison project and use synthetic inputs, outputs, and metadata only. Keep credentials outside tracked files.
3. Prefer a small, explicitly instrumented sample over an agent rewriting the main application. Pin the SDK version and review the sample before running it. If testing the wizard itself, run it only in that disposable directory and record its file changes and tool choices.
4. Exercise a shared fixture: nested spans, one failed task, a dataset revision, deterministic scorers, two experiments, a comparison, and human feedback. Preserve original identifiers and exported evidence when checking round-trip behavior.
5. Compare equivalent cases and scorer definitions. Report setup effort, correctness, missing features, and measured latency separately. Synthetic results do not establish production speed, cost, or scale advantages.
6. When finished, revoke the comparison credential and remove disposable local credential files. Check that no SDK dependency, tracing initialization, or credential was added to MindTrust accidentally.

For the broader feature inventory and parity criteria, see [Braintrust research](braintrust-research.md).
