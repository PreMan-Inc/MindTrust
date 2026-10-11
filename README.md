# MindTrust

**Agent observability and evaluation, by PreMan.**

MindTrust is a self-hosted application for tracing agents, curating regression datasets, running evaluations, and comparing changes. It is an independently built first release informed by a detailed study of Braintrust’s publicly documented workflows.

The goal is a lower-cost, faster alternative. **Comparative cost and performance have not yet been established.** This release implements the core feedback loop; it does not claim full Braintrust or enterprise parity.

![MindTrust dashboard with clearly labeled synthetic data](docs/images/mindtrust-overview.jpg)

## Run locally

Requires **Node.js 24 or newer**.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5190**. The API runs at **http://127.0.0.1:4310**. Data persists in `data/mindtrust.sqlite`.

The first start seeds an explicitly labeled synthetic workspace with traces, a dataset, two contrasting experiments, scorer definitions, prompt history, and review examples. It makes no model calls. Set `MINDTRUST_SEED=false` before the first start for an empty instance; that setting does not delete previously seeded data.

For the built app on a single port:

```sh
npm run build
npm start
```

Then open **http://127.0.0.1:4310**.

## What works

- **Projects and observability:** persistent projects, searchable traces, status filters, paginated logs, nested span inspection, timing, input/output, metadata, tokens, and explicit unknown costs.
- **Dataset curation:** create and edit cases, import JSON records, export data, inspect immutable revisions, and turn reviewed traces into cases with explicitly chosen expectations.
- **Evaluations:** run echo/template tasks or a configured model provider, pin dataset revisions, snapshot scorer definitions, repeat trials, bound concurrency, inspect failures, cancel runs, and export results.
- **Experiment comparison:** align cases by row ID and trial, inspect per-case score changes, and warn about incompatible coverage. Missing scores remain missing.
- **Scorers:** exact match, containment, and JSON validation with optional field paths. The Node SDK also executes custom scorer functions locally.
- **Prompts and playground:** version prompt text, render input variables, test deterministic templates, and execute real model calls when a provider is configured.
- **Review:** save judgments, comments, and expected outputs against traces and evaluation cases. Human review does not rewrite automatic scores.
- **Integrations:** a dependency-free Node.js tracing/evaluation SDK and an OTLP/HTTP **JSON trace** receiver with parent relationships and retry-safe span IDs.
- **Instance access:** optional administrator token, hashed API keys, key revocation, origin checks, request limits, and loopback defaults.

Everything displayed as sample activity is synthetic. User-created objects use the same persisted API and storage.

## Connect an application

Use the repository-local SDK; it is not published to npm yet. Replace the project ID with one created in MindTrust, or use the seeded demo project for exploration.

```js
import { MindTrust } from './sdk/index.mjs';

const client = new MindTrust({
  baseUrl: 'http://127.0.0.1:4310',
  projectId: 'demo-project',
  apiKey: process.env.MINDTRUST_API_KEY,
});

await client.trace(
  'support-agent',
  { input: { request: 'Order status' }, kind: 'agent' },
  async (span) => {
    const order = await span.trace(
      'lookup-order',
      { kind: 'tool', input: { id: 'example-1' } },
      async () => ({ status: 'shipped' }),
    );
    return order;
  },
);

await client.flush();
```

`flush()` is explicit: await it before exiting or ending a short-lived request. Failed deliveries retain their batch for retry. Buffer overflow throws; if the task itself also failed, that original error is preserved and `client.lastLoggingError` records the logging failure. The SDK is Node-only and does not implement the Braintrust SDK protocol.

Run a complete local SDK evaluation example:

```sh
node examples/evaluate.mjs
```

This creates a separate synthetic project and dataset, executes six cases, records nested traces, and imports the scored experiment. For an authenticated instance, set `MINDTRUST_API_KEY`; for another server, set `MINDTRUST_URL`.

## Real model calls

Set `OPENAI_API_KEY` and, optionally, `OPENAI_BASE_URL` in the server’s `.env`, then restart. Select the provider task in Playground or an evaluation. Credentials stay on the server. The integration uses the OpenAI-compatible, non-streaming chat-completions shape; compatibility with every provider/model is not implied.

Provider tokens are recorded when supplied. Dollar cost remains unknown unless instrumentation explicitly reports it. Local template/echo tasks make no provider calls; a zero model charge does not mean zero infrastructure cost.

## OpenTelemetry

Send an OTLP/HTTP JSON payload to:

```text
POST http://127.0.0.1:4310/v1/traces
Content-Type: application/json
Authorization: Bearer <key-if-enabled>
x-mindtrust-project-id: <project-id>
```

The receiver accepts `resourceSpans` / `scopeSpans`, preserves trace/span IDs and parentage, and retains attributes. It does **not** support protobuf, gRPC, the logs/metrics signals, or Braintrust’s `x-bt-parent` routing. Standard exporters often default to protobuf; select JSON explicitly or adapt the payload.

## Authentication and deployment

Local development is unauthenticated by default and binds loopback. Set `MINDTRUST_ADMIN_TOKEN` to enable authentication. Paste that token in **Settings → Access** for the UI; generate revocable instance API keys for applications. API keys have access to the whole instance, not per-project roles.

Non-loopback binding requires an administrator token. For a remote origin behind a TLS reverse proxy, configure `MINDTRUST_ALLOWED_ORIGINS` as a comma-separated list of exact origins. Network and TLS configuration remain the operator’s responsibility.

A Dockerfile and Compose configuration are included. Configure a strong `MINDTRUST_ADMIN_TOKEN` in `.env`, then:

```sh
docker compose up --build
```

Compose binds the host port to loopback and persists SQLite in a named volume. This is a single-instance deployment; do not share the same database across multiple API processes. See [operating boundaries](docs/architecture.md) for recovery and backup considerations.

## Verify

```sh
npm run check
```

The suite exercises API persistence, dataset snapshots, evaluations, auth and revocation, imports, real HTTP provider contracts using a local fixture, OTLP, and SDK concurrency/error handling. No paid provider credentials are needed for tests. CI runs the checks on Node.js 24.

## Research and design

- [Braintrust research](docs/braintrust-research.md): primary-source product inventory, public API/SDK behavior, architecture, parity requirements, and benchmark methodology.
- [API contract](docs/api-contract.md): routes and payload shapes.
- [Architecture](docs/architecture.md): implementation choices, comparison/cost semantics, and operational boundaries.
- [Migration guide](docs/migration.md): field coverage and a staged migration procedure.

## What remains before a full replacement

This release does not include Brainstore/BTQL, full Braintrust API/SDK compatibility, distributed storage or workers, remote code sandboxes, online scoring automations, streaming/multi-provider gateway routing, attachments, alerts, assigned/blinded human-review queues, Loop/Topics/Patterns, or enterprise SSO/RBAC/audit controls. The research document describes these capabilities and their acceptance criteria.

The practical next step is to dual-run a real customer workflow and measure identical workloads for correctness, end-to-end latency, total cost, and operational reliability. Do not retire an existing service on the basis of synthetic demo results.
