# PreMan workspace sign-in

This optional integration lets the hosted PreMan experience use your existing PreMan login and selected **workbench workspace**. Standalone Verus requires no PreMan account: independent installations can use their own local accounts or OIDC, and `MINDTRUST_PREMAN_ENABLED` is disabled by default. See the [standalone setup](../README.md#run-locally) and [authentication and deployment guide](../README.md#authentication-and-deployment).

When enabled, Verus uses PreMan's verified identity and workbench workspace membership. It does not accept a PreMan password, share the PreMan JWT signing secret, link accounts by email, or assign existing data to the first person who signs in. Organizations and workbench workspaces are different PreMan concepts; this integration accepts only `tenant_kind: workbench_workspace`.

## Enable the integration

Set `MINDTRUST_PREMAN_ENABLED=true` and `MINDTRUST_PREMAN_ISSUER=https://api.preman.live` in the operator-managed environment file. Retain the normal production bootstrap secret and exact `MINDTRUST_ALLOWED_ORIGINS=https://verus.preman.live`. Redemption always uses `https://api.preman.live/auth/verus/redeem`, with certificate verification, no redirects, a five-second deadline, and a 16 KiB response limit. A test transport override cannot run in production.

On a deployment with this integration enabled, the console's primary sign-in action opens `https://app.preman.live/workbench/verus`. Local password, OIDC, and bootstrap recovery remain available to existing authorized accounts. PreMan identities have no local password and their membership is managed in PreMan. The console omits its own password and logout controls for those identities.

With this integration enabled, CSP permits framing only by `https://app.preman.live`. The conflicting `X-Frame-Options: DENY` header is omitted in this mode. All other deployments retain frame denial. Credentialed browser CORS for the PreMan app is limited to `/api/auth/preman/exchange` and `/api/auth/logout`; it does not grant cross-origin access to project data or session reads. The exchange also accepts the Verus origin and native requests without an Origin, but rejects other supplied origins and non-JSON bodies.

## Handoff and renewal

PreMan issues an opaque, one-use launch code bound to a public-client PKCE challenge after validating its logged-in user and that user's current workspace membership. The native main process or PreMan web module posts strict JSON `{code, code_verifier}` to `/api/auth/preman/exchange`. No bearer credential is accepted on this route. Codes and native tokens must not appear in URLs, logs, or remote renderer state.

Verus redeems the code at the fixed backend and validates the exact response fields: `issuer`, `subject`, `tenant_kind`, UUID `tenant_id`, `tenant_name`, `role` (`owner`, `admin`, or `member`), `email`, `email_verified: true`, and ISO `session_expires_at`. The issuer must exactly match configuration and expiration must be in the future and at most five minutes away. The immutable identity key is issuer plus subject; verified email is profile data only. Owner/admin map to workspace administrator; member maps to editor. Both remain inside the verified workspace.

The response is the usual `{principal, csrfToken, expiresAt}`, plus `upstreamIdentity: {issuer, subject, tenantKind, tenantId}`. The principal includes `workspaceId` (the internal Verus workspace ID) and `authMethod: preman`. Clients must compare `upstreamIdentity` with the account/workspace they launched. The `mindtrust_session` cookie is HttpOnly, SameSite=Strict, and Secure in production. Its absolute deadline is bounded by both the upstream grant and five minutes. Data mutations and logout require its CSRF token.

Each renewal requires a new verified launch grant. When the existing live cookie belongs to the same identity/workspace and its CSRF token is supplied, Verus extends that session without changing its cookie or CSRF token. A fresh explicit login with another identity/workspace, or without proof of the old CSRF token, revokes the old cookie and creates a new session. No identity or permissions are taken from that old cookie. Expired cookies can also be replaced using a new verified grant. The console refreshes session identity and permissions on focus and every minute while visible.

PreMan membership and account access are revalidated when each grant is issued. Existing Verus sessions therefore retain access for no longer than their five-minute deadline if upstream membership is removed. The native/web host should renew before expiry and revoke the Verus session and clear its cookie when the PreMan account signs out or the workspace context is destroyed. PreMan's own token-revocation limitations are unchanged.

## Schema 4 and existing data

The transactional authentication migration preserves existing record IDs, local users, passwords, session hashes, API-key hashes, expiry dates, revocations, and project scopes. Existing data is assigned to an internal `legacy` workspace. `projectIds: null` now means all projects inside the credential's workspace. New PreMan workspaces receive separate empty workspaces, never the legacy data.

Every project has immutable workspace ownership. Native and Braintrust operations enforce that ownership before reading or changing data; compatibility name resolution is workspace-scoped. Existing keys retain the `MindTrust` organization alias. New workspace keys expose their own organization identity. Team, key, and audit routes are workspace-scoped. PreMan-managed users cannot be locally provisioned, reset, or reassigned through team APIs. Deployment operations and metrics require the bootstrap/development operator capability rather than a tenant administrator.

Back up and verify the database before deploying schema 4. Older Verus binaries refuse to open it; rollback uses the saved pre-migration snapshot and the previous build, not an in-place downgrade. The backup tool accepts versions 2, 3, and 4. This remains one SQLite writer with a shared evaluation worker pool and provider configuration; workspace permissions do not add per-workspace capacity isolation, quotas, or high availability.

## Explicitly attach existing data

Only an operator can associate the legacy workspace with a verified PreMan workspace. Before that PreMan workspace's first Verus sign-in, obtain a fresh launch code/PKCE verifier for a verified PreMan owner/admin and save exactly `{code, code_verifier}` in a private regular file (mode 0600). Stop the Verus writer, verify its backup, then run:

```sh
node --import tsx scripts/bind-preman-workspace.ts /absolute/path/mindtrust.sqlite /private/path/launch-proof.json
```

The command redeems the proof through the fixed trusted server, acquires the exclusive database lock, binds the legacy workspace, and appends `workspace.bind.preman` to its audit history. It never merges identities by email or changes project IDs and API keys. This proof-file mode refuses rebinding and already-provisioned target workspaces. Remove the expired proof file using normal secret-handling procedures and restart the service.

If the first shared sign-in has already created an **empty** workspace, the operator can instead bind that shell using the verified session stored by Verus. This avoids reading any PreMan JWT, browser cookie, or PKCE verifier. Confirm that the user has authorized attaching the existing data to that exact workspace, verify a backup, and let an owner/admin complete a fresh shared sign-in or renewal. Inspect the trusted server's `workspaces` row and its `auth_external_identities`/`auth_sessions` records to confirm the immutable issuer, tenant ID and subject. Do not infer authority from an email address or workspace name. Stop the writer and, before the five-minute session deadline, run:

```sh
node --import tsx scripts/bind-preman-workspace.ts /absolute/path/mindtrust.sqlite --existing-workspace INTERNAL_WORKSPACE_UUID
```

`INTERNAL_WORKSPACE_UUID` is the exact Verus `workspaces.id`, not the PreMan tenant UUID. This offline mode requires schema 4 and the exclusive writer lock. It checks a live, unrevoked `auth_method=preman` session with the exact stored issuer/subject/tenant relationship, an enabled passwordless PreMan user and current enabled administrator membership, a deadline no more than five minutes away, and a successful server-recorded PreMan login audit within five minutes. A session's original creation time may be older because verified renewal preserves its cookie. These are the last verified upstream permissions; this offline operation does not add a fresh network membership lookup.

The target must have no projects or API keys, including revoked keys; all its memberships and sessions must belong to valid PreMan identities. Local identities, conflicting legacy memberships, data-bearing audit references, unknown workspace-reference tables, unexpected workspace or identity foreign keys, triggers, invalid foreign keys and an already-bound legacy workspace cause refusal. An expired, revoked, member-only or incorrectly bound session cannot authorize the operation. Targets containing any work require a separately reviewed data migration.

The transaction keeps the `legacy` workspace ID and every existing project, credential, local user and session unchanged. It moves the empty shell's validated PreMan memberships, sessions and audit records to `legacy`, transfers the exact tenant binding, removes the empty shell, and records `workspace.bind.preman.existing`. Failure rolls back the whole operation. Restart the service and refresh Verus to load the attached evaluations; existing local recovery and API credentials retain their scopes. Creating this command does not execute a live migration.
