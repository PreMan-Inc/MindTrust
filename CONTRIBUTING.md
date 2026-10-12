# Contributing to Verus

Use the [README](README.md) to clone the repository and start a local instance with Node.js 24 or newer. Standalone development does not require a PreMan account or model-provider credentials. The default workspace uses clearly labeled synthetic data.

Contributions are made under the project's [Apache License 2.0](LICENSE).

## Working on a change

- Describe the problem and expected behavior in an [issue](https://github.com/PreMan-Inc/MindTrust/issues) or pull request. Include a minimal reproduction for a bug.
- Keep changes focused. Update the relevant documentation when setup, APIs, or user-visible behavior changes, and add or update tests when needed to verify the behavior.
- Use synthetic fixtures. Keep `.env` files, credentials, databases, customer traces, and private PreMan source out of contributions. Live agent examples are optional, make paid model calls, and require their documented setup.
- Preserve the existing `MindTrust` SDK exports, `MINDTRUST_*` configuration, and compatibility routes when changing public-facing Verus branding.

The main directories are `web/` for the React console, `server/` for the API and SQLite storage, `sdk/` for the native Node.js client, `shared/` for shared types, and `tests/` for automated checks. See the [architecture](docs/architecture.md) and [API contract](docs/api-contract.md) for context.

## Checks

Install the pinned dependencies with `npm ci`, then run the complete Node.js check:

```sh
npm run check
```

This runs TypeScript checking, the test suite, and the production build. These checks use synthetic data and local fixtures; they need no paid provider credentials. During development, use `npm run typecheck`, `npm test`, or `npm run build` separately. Run a focused test file with, for example:

```sh
node --import tsx --test tests/sdk.test.ts
```

For changes to Braintrust compatibility, also run the pinned Python SDK contracts with Python 3.12:

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r tests/contracts/requirements.txt
python -m unittest discover -s tests/contracts -p '*_test.py' -v
```

The public-agent scorer checks make no model calls:

```sh
python -m unittest discover -s examples/agents/public -p 'test_scorers.py' -v
```

The [CI workflow](.github/workflows/ci.yml) also validates deployment configuration and builds and smoke-tests the production container. See the [production runbook](docs/production-operations.md) when changing deployment or recovery behavior.

In your pull request, explain the resulting behavior, which checks you ran, and any remaining limitations. For UI changes, include screenshots using synthetic data. Keep Braintrust support claims within the workflows established by the [compatibility tests](docs/braintrust-compatibility.md).
