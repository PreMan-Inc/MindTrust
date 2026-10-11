# Hosting Verus at verus.preman.live

This procedure prepares and verifies a deployment; these instructions are not evidence that the hostname is live. Verus is the product name. Existing `MINDTRUST_*` configuration, SDK imports, database names, and `/app/MindTrust/` compatibility links remain supported.

## Prepare the host

Use the [production runbook](production-operations.md) and the supplied `Dockerfile` or `deploy/compose.production.yaml`. This application needs one continuously running Node 24 process and a durable local writable SQLite volume. Do not use ephemeral function storage, shared NFS, or multiple replicas over one database. Squarespace manages the DNS record; a separate application host runs the service.

For the Compose deployment, set `DOMAIN=verus.preman.live` and a valid certificate contact email in an operator-managed environment file outside Git. Generate a unique bootstrap secret with `openssl rand -hex 32`. The supplied stack sets production mode, exact HTTPS origin, disabled demo seeding, and persistent application/certificate volumes. Point the Squarespace `verus` DNS record to the actual host address provided by the chosen hosting service, then allow Caddy to provision HTTPS. Preserve the existing root-domain and other subdomain records.

For another container host, configure:

```text
NODE_ENV=production
MINDTRUST_MODE=production
MINDTRUST_HOST=0.0.0.0
MINDTRUST_ALLOWED_ORIGINS=https://verus.preman.live
MINDTRUST_SEED=false
MINDTRUST_DB=/app/data/mindtrust.sqlite
```

Set `MINDTRUST_ADMIN_TOKEN` through the host's secret manager, mount durable storage at `/app/data`, and grant the container's `node` user write access. Route the host's assigned `PORT` to the service (default `4310`). Configure HTTPS and HTTP-to-HTTPS redirection. `MINDTRUST_TRUSTED_PROXIES` accepts only explicit, known proxy IP addresses; leave it unset when those addresses are not stable. Do not set a blanket proxy trust value. Block public operator endpoints as in `deploy/Caddyfile`, while using `/readyz` for internal readiness checks.

Keep the bootstrap token private, provision a named administrator, and issue a scoped, expiring API key for the PreMan evaluation project. Run the existing build/tests before deploying, and confirm the database survives a service restart. Configure and verify backups using the production runbook.

## Check the public deployment

With Node 24 or newer, run:

```sh
MINDTRUST_URL=https://verus.preman.live node scripts/verify-hosted.mjs
```

Supply `MINDTRUST_API_KEY` through your normal environment/secret manager and repeat to include an authenticated project-list read. Do not put credentials in the URL or command arguments. The script makes GET requests only, retains certificate verification, refuses redirects, and allows 15 seconds per request. Any failed check exits with status 1 and a specific diagnostic; success exits with status 0. Without a key, the authenticated check is explicitly skipped.

The checker verifies the Verus HTML title and shell, referenced JavaScript/CSS assets on the same origin, a direct experiment URL's HTML fallback, API health, production authentication flags, and denial of anonymous project access. It does not execute browser JavaScript, validate the existence of the placeholder experiment, or prove that every workflow works. Verify named-user sign-in, navigation, dataset/trace/experiment details, secure cookies, HTTP-to-HTTPS redirection, and persistence across a restart separately in the hosted service.

For an isolated local production-mode integration check only, start the built server on loopback with a fresh temporary database, strong test token, and exact HTTPS allowed origin, then use:

```sh
MINDTRUST_URL=http://127.0.0.1:4310 node scripts/verify-hosted.mjs --allow-loopback-http
```

This explicit exception accepts only a loopback hostname and prints that public DNS/TLS remain unverified. It is not a substitute for the HTTPS run above.

## Rerun PreMan against the hosted service

Follow [PreMan agent evaluations](preman-agent-evals.md) for the authorized backend checkout, Python environment, and model credential. Set `MINDTRUST_URL=https://verus.preman.live` and a scoped `MINDTRUST_API_KEY`, then run:

```sh
node examples/agents/preman/run.mjs
```

This run makes paid model calls and writes a dataset, experiment, and traces to the hosted service. The five cases use the real shared PreMan loop with synthetic read-only fixtures; they do not test the separate desktop streaming path or a complete PreMan installation. Read the saved experiment back from the hosted API and inspect the linked model/tool traces and all four scores. Preserve failed outcomes honestly. A negative control is a separate paid run (`--negative-control`); its evidence/grounding scores are expected to fall.

Public HTTPS checks, browser checks, persistence checks, and model evaluation results establish only the behaviors actually observed. They do not establish perfect operation, high availability, a production SLA, or complete Braintrust compatibility.
