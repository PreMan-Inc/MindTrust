# Operating an isolated customer workspace

MindTrust 0.2 supports an **isolated customer deployment** by default. Optional [PreMan workspace sign-in](preman-shared-login.md) adds explicit workspace ownership inside one deployment. Separate deployments still receive their own process, volume, bootstrap secret, provider credentials, hostname, and backup destination. The repository does not provision cloud accounts or provide a shared SaaS control plane. No live customer deployment is implied by these files.

This choice makes customer separation explicit while the service still uses a single SQLite writer. Never horizontally scale replicas over the same database file or mount it over NFS. High-availability, distributed ingestion/querying, and high-volume retention remain engineering work. SQLite itself documents the single-writer boundary in [its deployment guidance](https://www.sqlite.org/whentouse.html).

## Start a customer deployment

Use a dedicated host with Docker and Docker Compose, a persistent encrypted local disk, and a DNS hostname pointing at the host. Reserve ports 80 and 443 for Caddy. Validate capacity against the customer's workload instead of using the local synthetic benchmark as a sizing promise.

1. Build from a reviewed Git commit. Copy `deploy/production.env.example` to an operator-managed file outside Git, set its domain and certificate email, set `MINDTRUST_IMAGE` to a unique release tag such as `customer-workspace-mindtrust:COMMIT`, and generate a unique bootstrap secret (`openssl rand -hex 32`). Restrict that file to its operator account. Separate workspaces must not reuse secrets or volumes.
2. Run `docker compose --env-file /secure/customer.env -f deploy/compose.production.yaml -p customer-workspace config --quiet`. With the same arguments, run `build mindtrust`, then `up --no-build -d`. Never overwrite an existing release tag.
3. Check service health with `docker compose --env-file /secure/customer.env -f deploy/compose.production.yaml -p customer-workspace ps`. Caddy terminates HTTPS. The application has no published host port; its internal readiness check must pass before the proxy starts.
4. Visit the configured HTTPS hostname. Use the bootstrap-token option to provision the first named administrator, then use personal sign-in or configured SSO. Store the bootstrap token for recovery, not shared daily access. Give application keys an explicit role, project scope, and expiry.
5. Run the customer acceptance procedure below before routing production telemetry.

The example network assigns Caddy `172.30.10.2` and the application `172.30.10.3`. Both addresses are explicit so the application, which starts first, cannot claim Caddy's address. Only the exact proxy IP is trusted for forwarded client addresses. If changing the network, change `PROXY_IP`, `APP_IP`, and `WORKSPACE_SUBNET` together, keeping both addresses distinct and inside the subnet. A distinct VM per customer avoids overlapping Docker networks and reduces the shared failure domain. The application fails startup without a strong bootstrap token and exact HTTPS origin in production mode; demo seeding is disabled by the entry point.

The runtime is a non-root container, uses a read-only root filesystem, a writable data volume and temporary directory, drops Linux capabilities, and bounds memory and process count. These controls are configuration, not a security certification. The bootstrap and provider environment variables remain visible to the host's container administrator: restrict that host and use a managed secret store in a deployed environment.

## Team access and SSO

Viewer, editor, and administrator roles apply on every request. Project scopes are enforced for native and compatibility routes. Keys are hashed at rest, expire, and can be revoked. Human sessions use opaque hashed identifiers, HttpOnly cookies, CSRF tokens, and current database permissions. Password changes and administrative session revocation invalidate existing sessions. Production cookies are Secure.

Optional OIDC uses one operator-configured HTTPS issuer, client ID, client secret, and exact callback URL. Register `https://CUSTOMER_HOST/api/auth/oidc/callback` with the identity provider and set the `MINDTRUST_OIDC_*` variables. Only explicitly provisioned, SSO-enabled accounts can sign in; this is not open domain-based registration. SAML, SCIM, and automated identity-provider group provisioning are not implemented.

## Probes, metrics, and logs

- `/livez` reports that the process is alive. `/readyz` checks database availability and drain state, returning 503 while unavailable.
- `/metrics` exposes Prometheus counters for HTTP requests and cumulative duration, active requests, evaluation backlog, active tasks, readiness, and process RSS. It requires the bootstrap operator credential.
- `/api/operations` provides the equivalent operational snapshot to operators. A workspace administrator or administrator API key does not grant deployment-wide access.
- The supplied public Caddy configuration blocks those operator endpoints. Scrape them over the protected internal network using the protected operator credential; do not publish the Docker API or application port to bypass the proxy.
- Production HTTP logs contain request IDs, route templates, method, status, and duration. They exclude request bodies, raw URLs/query strings, cookies, authorization headers, and provider payloads. Audit events record actor IDs, action, project, time, and outcome. Configure protected log forwarding, access, retention, and alerting on the host.

Admission control returns 503 with `Retry-After` when requests are saturated or draining. Evaluation execution has at most four active runs and sixteen active tasks, with bounded pending admission. Only active runs load snapshots. Provider calls have timeouts and response-size limits. Retry ingestion with stable identifiers; do not assume side-effecting external tasks are exactly once.

## Backup and recovery

The CLI uses SQLite's online-backup API to take a consistent snapshot while the service runs. It validates database integrity, records a SHA-256 checksum/schema/record counts, and writes files with private permissions. It does not copy an incomplete live database without its WAL.

```sh
npm run backup -- create /data/mindtrust.sqlite /backups/workspace-2026-10-10.sqlite
npm run backup -- verify /backups/workspace-2026-10-10.sqlite
npm run backup -- restore /backups/workspace-2026-10-10.sqlite /recovery/mindtrust.sqlite
```

The `*.manifest.json` accompanies the snapshot. Existing backup and restore destinations are refused. Restores only write a new database path; inspect it in a separate isolated process before changing the service's database path. A snapshot includes hashed credentials, user records, and any application data: encrypt the backup disk and offsite storage, restrict operators, and test restorations. The checksum detects damage; it is not an authenticated signature against an attacker able to replace both files.

Set a backup schedule, offsite copy, expiry, and restore objective per customer with infrastructure automation. Those services are not created by this repository. A daily snapshot cannot promise less than a day of data loss. Recovery time depends on backup size and host provisioning and must be measured. Retention of application records and audit events is currently operator-managed; no automatic deletion is enabled.

## Shutdown, upgrade, and rollback

SIGTERM first marks readiness unavailable and rejects new application work. Accepted HTTP requests finish, evaluation workers stop, and the database closes. Persisted unfinished server-run evaluations resume after restart; a model request that was in flight may run again. The process has a 45-second shutdown deadline and the supplied container allows 50 seconds. An OS-backed lock on a separate local SQLite file prevents two entry-point processes from owning the same workspace; it releases after a crash.

Before any upgrade build, preserve and verify the running image under its own release tag, take and verify a backup, rehearse the version on a restored copy, and rerun the SDK contracts. Build the next version under a new `MINDTRUST_IMAGE` tag, retain the previous tag, and verify another backup after starting the new release. See the [Lightsail upgrade steps](verus-lightsail.md#upgrading-an-existing-release) for image identity checks. Keep the last deployable image and pre-upgrade backup. Newer unknown schema versions are refused. Do not roll back to 0.1 by switching executable code against an upgraded database: the old key policy does not understand scoped/revoked credentials. Restore the matching pre-upgrade snapshot into a new volume and test it before routing traffic.

## Customer acceptance and current limits

Before a customer switches, inventory its exact SDK versions, ingestion formats, exported datasets, prompt/model usage, custom scorers, review/alerts, access requirements, volume, and recovery objectives. Replay representative sanitized records into a separate workspace. Verify counts, hierarchy, scores, dataset versions, annotations, and error handling; run old and new services in parallel before moving traffic. Preserve the original service and export until the agreed comparison and rollback tests pass.

Dataset snapshots and experiment detail/comparison views still load complete records. The request-size limit does not bound the total size of a dataset built through repeated imports. Include representative dataset sizes, history, experiment volume, and disk growth in acceptance testing; the local trace benchmark does not establish safe limits for those workloads.

See [the compatibility contract](braintrust-compatibility.md) for tested SDK features and unsupported operations. Automated tests and a local load sample do **not** establish universal Braintrust parity, a production SLA, high availability, independent penetration-test coverage, SOC 2 compliance, or comparative cost/performance. This candidate requires a real customer pilot before being described as a production replacement for that team.
