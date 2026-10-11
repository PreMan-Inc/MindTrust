import { useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Users,
  X,
} from 'lucide-react';
import type { Project, ServerInfo } from '../shared/types';
import type {
  AuditEvent,
  WorkspaceApiKey,
  WorkspaceRole,
  WorkspaceUser,
} from '../shared/team-types';
import { api, copy, date, post, useAction, useData, useWorkspace } from './lib';
import { usePermissions, useSession } from './session';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Form,
  FormActions,
  Loading,
  Modal,
  PageHeader,
  Section,
} from './ui';
const roleDescription: Record<WorkspaceRole, string> = {
  viewer: 'Read traces, datasets, prompts, and evaluation results.',
  editor: 'Read and update data, run evaluations, and add reviews in assigned projects.',
  admin: 'Manage every project, workspace members, API keys, and audit records.',
};
export function SettingsPage() {
  const { refresh, refreshAll, notify, navigate } = useWorkspace();
  const auth = useSession();
  const { canAdmin } = usePermissions();
  const [tab, setTab] = useState(auth.session.principal.kind === 'bootstrap' ? 'team' : 'account');
  const action = useAction();
  const info = useData<ServerInfo>('/info', refresh);
  const projects = useData<Project[]>('/projects', refresh);
  const managed =
    auth.session.principal.kind === 'user' && auth.session.principal.authMethod === 'preman';
  const tabs = canAdmin
    ? ['account', ...(!managed ? ['team'] : []), 'api keys', 'audit']
    : ['account'];
  return (
    <>
      <PageHeader
        eyebrow="ONE WORKSPACE. CLEAR BOUNDARIES."
        title="Settings & access"
        description="Give people and applications exactly the access they need."
        actions={
          <Button onClick={() => navigate('integrations')}>
            Connect an application
            <ArrowRight size={14} />
          </Button>
        }
      />
      <div className="tabs settings-tabs" role="tablist" aria-label="Workspace settings">
        {tabs.map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t === 'api keys' ? 'API keys' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {!auth.status.enabled && (
        <div className="warning-banner">
          <ShieldOff size={17} />
          <span>
            <strong>Authentication is off in this development workspace.</strong> Configure
            workspace authentication before making it accessible to anyone else.
          </span>
        </div>
      )}
      {auth.session.principal.kind === 'bootstrap' && (
        <div className="info-banner">
          <ShieldCheck size={17} />
          <span>
            You are using the server’s administrator token. Create a named administrator account
            under Team, then sign out and use that account for day-to-day work.
          </span>
        </div>
      )}
      <ErrorBox message={action.error} />
      {tab === 'account' && (
        <div className="settings-grid">
          <div>
            <Section title="Your account" detail="Your permissions are enforced by the server.">
              <div className="account-detail">
                <div className="account-identity">
                  <span className="avatar large">{initials(auth.session.principal.name)}</span>
                  <div>
                    <h3>{auth.session.principal.name}</h3>
                    <p>
                      {auth.session.principal.email || credentialLabel(auth.session.principal.kind)}
                    </p>
                  </div>
                  <RoleBadge role={auth.session.principal.role} />
                </div>
                <div className="key-value">
                  <span>Access</span>
                  <strong>
                    {managed && auth.session.principal.role === 'admin'
                      ? 'Manage projects, API keys, and audit records in this workspace. Membership is managed in PreMan.'
                      : roleDescription[auth.session.principal.role]}
                  </strong>
                  <span>Projects</span>
                  <strong>
                    {scopeLabel(auth.session.principal.projectIds, projects.data || [])}
                  </strong>
                  <span>Sign-in method</span>
                  <strong>
                    {managed ? 'Managed in PreMan' : credentialLabel(auth.session.principal.kind)}
                  </strong>
                  <span>Session expires</span>
                  <strong>
                    {auth.session.expiresAt
                      ? date(auth.session.expiresAt)
                      : auth.session.principal.kind === 'development'
                        ? 'Development session'
                        : 'Managed by credential expiry'}
                  </strong>
                </div>
                {auth.status.enabled && !managed && (
                  <Button disabled={action.busy} onClick={() => action.run(auth.signOut)}>
                    <LogOut size={14} />
                    Sign out of this browser
                  </Button>
                )}
              </div>
            </Section>
            {auth.session.principal.kind === 'user' && !managed && <ChangePassword />}
          </div>
          <Section title="Workspace runtime" detail="One isolated workspace for your team.">
            <div className="runtime-details">
              <div>
                <span>Version</span>
                <Badge>{info.data?.version || '—'}</Badge>
              </div>
              <div>
                <span>Authentication</span>
                <Badge tone={auth.status.enabled ? 'green' : 'amber'}>
                  {auth.status.enabled ? 'Enabled' : 'Development only'}
                </Badge>
              </div>
              <div>
                <span>Model provider</span>
                <Badge tone={info.data?.providerConfigured ? 'green' : 'neutral'}>
                  {info.data?.providerConfigured ? 'Configured' : 'Not configured'}
                </Badge>
              </div>
              <div>
                <span>Storage</span>
                <strong>{info.data?.storage || 'SQLite'}</strong>
              </div>
            </div>
            <ErrorBox message={info.error} />
            <div className="settings-tip">
              <ShieldCheck size={17} />
              <p>
                Provider credentials stay on the server. Your administrator configures model access
                through the deployment environment.
              </p>
            </div>
          </Section>
        </div>
      )}
      {tab === 'team' && canAdmin && !managed && <TeamPanel projects={projects.data || []} />}{' '}
      {tab === 'api keys' && canAdmin && <KeysPanel projects={projects.data || []} />}{' '}
      {tab === 'audit' && canAdmin && <AuditPanel />}
    </>
  );
}
export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0])
      .join('')
      .toUpperCase() || 'MT'
  );
}
function credentialLabel(kind: string) {
  return (
    (
      {
        user: 'Account · browser session',
        'api-key': 'API key · this tab only',
        bootstrap: 'Administrator token · this tab only',
        development: 'Local development access',
      } as Record<string, string>
    )[kind] || kind
  );
}
export function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <Badge tone={role === 'admin' ? 'green' : role === 'editor' ? 'neutral' : 'amber'}>
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </Badge>
  );
}
function scopeLabel(ids: string[] | null, projects: Project[]) {
  if (ids === null) return 'All projects in this workspace';
  if (!ids.length) return 'No projects assigned';
  return ids.map((id) => projects.find((p) => p.id === id)?.name || id).join(', ');
}
function AccessFields({
  role,
  setRole,
  projectIds,
  setProjectIds,
  projects,
}: {
  role: WorkspaceRole;
  setRole: (v: WorkspaceRole) => void;
  projectIds: string[] | null;
  setProjectIds: (v: string[] | null) => void;
  projects: Project[];
}) {
  const all = projectIds === null;
  return (
    <>
      <Field label="Role" hint={roleDescription[role]}>
        <select
          value={role}
          onChange={(e) => {
            const value = e.target.value as WorkspaceRole;
            setRole(value);
            if (value === 'admin') setProjectIds(null);
          }}
        >
          <option value="viewer">Viewer · read only</option>
          <option value="editor">Editor · read and write</option>
          <option value="admin">Administrator · full workspace access</option>
        </select>
      </Field>
      <fieldset className="scorer-picker">
        <legend>Project access</legend>
        {role === 'admin' ? (
          <p className="scope-note">
            Administrators manage the entire workspace and have access to every project.
          </p>
        ) : (
          <>
            <label>
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setProjectIds(e.target.checked ? null : [])}
              />
              <span>
                <strong>All projects</strong>
                <small>Includes projects created in the future.</small>
              </span>
            </label>
            {!all && (
              <>
                <div className="scope-divider" />
                {projects.length ? (
                  projects.map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={projectIds?.includes(p.id) || false}
                        onChange={(e) =>
                          setProjectIds(
                            e.target.checked
                              ? [...(projectIds || []), p.id]
                              : (projectIds || []).filter((id) => id !== p.id),
                          )
                        }
                      />
                      <span>
                        <strong>{p.name}</strong>
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="scope-note">
                    No projects yet. Create a project before assigning specific access.
                  </p>
                )}
                {projectIds?.length === 0 && (
                  <p className="scope-note">
                    No project access will be granted until projects are assigned.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </fieldset>
    </>
  );
}
function TeamPanel({ projects }: { projects: Project[] }) {
  const { refresh, refreshAll, notify } = useWorkspace();
  const auth = useSession();
  const list = useData<WorkspaceUser[]>('/users', refresh);
  const [editing, setEditing] = useState<WorkspaceUser | 'new' | null>(null);
  const [revoking, setRevoking] = useState<WorkspaceUser | null>(null);
  const action = useAction();
  return (
    <>
      <Section
        title="Team members"
        detail="Create accounts directly. This workspace does not send invitation emails."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={14} />
            Add member
          </Button>
        }
      >
        <ErrorBox message={list.error || action.error} />
        {list.loading && !list.data ? (
          <Loading />
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table className="access-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Projects</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="member-cell">
                        <span className="avatar">{initials(user.name)}</span>
                        <div>
                          <strong>
                            {user.name}
                            {user.id === auth.session.principal.id && <small>You</small>}
                          </strong>
                          <span>{user.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={user.role} />
                    </td>
                    <td>
                      <span className="scope-text">{scopeLabel(user.projectIds, projects)}</span>
                    </td>
                    <td>
                      <Badge tone={user.disabled ? 'red' : 'green'}>
                        {user.disabled ? 'Disabled' : 'Active'}
                      </Badge>
                      {user.oidcLinked && <Badge>SSO linked</Badge>}
                      {user.managedBy === 'preman' && <Badge>Managed in PreMan</Badge>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          disabled={user.managedBy === 'preman'}
                          onClick={() => setEditing(user)}
                        >
                          <Pencil size={12} />
                          Edit
                        </Button>
                        <button
                          className="icon-button"
                          aria-label={`Revoke sessions for ${user.name}`}
                          title="Revoke all browser sessions"
                          disabled={user.managedBy === 'preman'}
                          onClick={() => setRevoking(user)}
                        >
                          <LogOut size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Create the first administrator"
            description="Use a named account for everyday access. Share initial passwords with members through a secure channel."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Create account
              </Button>
            }
          />
        )}
      </Section>
      <div className="role-guide">
        {(['viewer', 'editor', 'admin'] as WorkspaceRole[]).map((role) => (
          <div key={role}>
            <RoleBadge role={role} />
            <p>{roleDescription[role]}</p>
          </div>
        ))}
      </div>
      {editing && (
        <UserEditor
          user={editing === 'new' ? undefined : editing}
          firstUser={!list.data?.length}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            list.reload();
            refreshAll();
            await auth.reload();
          }}
        />
      )}{' '}
      {revoking && (
        <Modal
          title={`Sign out ${revoking.name}?`}
          description="Revoke every active browser session for this member. Their password and API keys remain unchanged."
          onClose={() => setRevoking(null)}
        >
          <ErrorBox message={action.error} />
          <div className="form-actions">
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await post(`/users/${encodeURIComponent(revoking.id)}/revoke-sessions`, {});
                  const own = revoking.id === auth.session.principal.id;
                  setRevoking(null);
                  notify('Browser sessions revoked');
                  if (own) await auth.reload();
                })
              }
            >
              Revoke sessions
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function UserEditor({
  user,
  firstUser,
  projects,
  onClose,
  onSaved,
}: {
  user?: WorkspaceUser;
  firstUser: boolean;
  projects: Project[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useWorkspace();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<WorkspaceRole>(user?.role || (firstUser ? 'admin' : 'viewer'));
  const [projectIds, setProjectIds] = useState<string[] | null>(
    user ? user.projectIds : firstUser ? null : [],
  );
  const [disabled, setDisabled] = useState(user?.disabled || false);
  const [allowOidc, setAllowOidc] = useState(user?.allowOidc || false);
  const auth = useSession();
  const [resetPassword, setResetPassword] = useState(false);
  const action = useAction();
  return (
    <Modal
      title={
        user
          ? `Edit ${user.name}`
          : firstUser
            ? 'Create your administrator account'
            : 'Add a team member'
      }
      description={
        user
          ? 'Changes to role and project scope take effect on the server immediately.'
          : 'Create an account in this workspace. No email is sent.'
      }
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            const body = {
              name,
              role,
              allowOidc,
              projectIds: role === 'admin' ? null : projectIds,
              ...(user
                ? { disabled, ...(resetPassword ? { password } : {}) }
                : { email, password }),
            };
            if (user)
              await api(`/users/${encodeURIComponent(user.id)}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              });
            else await post('/users', body);
            setPassword('');
            notify(user ? 'Member access updated' : 'Member account created');
            onClose();
            await onSaved();
          })
        }
      >
        <div className="form-columns">
          <Field label="Full name">
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              required
              readOnly={!!user}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        <AccessFields
          role={role}
          setRole={setRole}
          projectIds={projectIds}
          setProjectIds={setProjectIds}
          projects={projects}
        />
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allowOidc}
            onChange={(e) => setAllowOidc(e.target.checked)}
          />
          <span>
            <strong>Allow organization SSO</strong>
            <small>
              {auth.status.oidc
                ? `Permit ${auth.status.oidc.label} sign-in for this member’s verified email. After the first sign-in, the external identity is bound to this account.`
                : 'Your administrator must configure an OIDC provider on the server before this member can use SSO.'}
            </small>
          </span>
        </label>
        {user && (
          <>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
              />
              <span>
                <strong>Disable account</strong>
                <small>Prevents sign-in and access for this member.</small>
              </span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={resetPassword}
                onChange={(e) => {
                  setResetPassword(e.target.checked);
                  setPassword('');
                }}
              />
              <span>
                <strong>Set a new password</strong>
                <small>Existing browser sessions will be revoked.</small>
              </span>
            </label>
          </>
        )}
        {(!user || resetPassword) && (
          <Field
            label={user ? 'New password' : 'Initial password'}
            hint="At least 12 characters. Share it with this member through a secure channel; it is not sent by email."
          >
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        <ErrorBox message={action.error} />
        <FormActions
          busy={action.busy}
          label={user ? 'Save access changes' : 'Create account'}
          onCancel={onClose}
        />
      </Form>
    </Modal>
  );
}
function KeysPanel({ projects }: { projects: Project[] }) {
  const { refresh, notify } = useWorkspace();
  const list = useData<WorkspaceApiKey[]>('/keys', refresh);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<WorkspaceApiKey | null>(null);
  const action = useAction();
  return (
    <>
      <Section
        title="Application API keys"
        detail="Use scoped credentials for SDKs and integrations. Keys expire and can be revoked immediately."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} />
            Create API key
          </Button>
        }
      >
        <ErrorBox message={list.error || action.error} />
        {revealed && (
          <div className="new-key-box">
            <strong>Copy “{revealed.name}” now.</strong>
            <p>
              The full key is shown once. Store it in your application’s secret manager, never in
              browser code.
            </p>
            <div className="copy-row">
              <code>{revealed.key}</code>
              <Button
                onClick={() =>
                  action.run(async () => {
                    await copy(revealed.key);
                    notify('API key copied');
                  })
                }
              >
                <Copy size={14} />
                Copy
              </Button>
            </div>
            <Button variant="ghost" onClick={() => setRevealed(null)}>
              <Check size={13} />
              I’ve saved this key
            </Button>
          </div>
        )}
        {list.loading && !list.data ? (
          <Loading />
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table className="access-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Role</th>
                  <th>Projects</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((key) => {
                  const expired =
                    !!key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
                  return (
                    <tr key={key.id}>
                      <td>
                        <div className="member-cell">
                          <KeyRound size={17} />
                          <div>
                            <strong>{key.name}</strong>
                            <span className="key-prefix">{key.prefix}…</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <RoleBadge role={key.role} />
                      </td>
                      <td>
                        <span className="scope-text">{scopeLabel(key.projectIds, projects)}</span>
                      </td>
                      <td className="muted nowrap">
                        {key.expiresAt ? date(key.expiresAt) : 'Legacy · no expiry'}
                      </td>
                      <td>
                        <Badge tone={key.revokedAt ? 'neutral' : expired ? 'amber' : 'green'}>
                          {key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active'}
                        </Badge>
                      </td>
                      <td>
                        <Button
                          variant="danger"
                          disabled={!!key.revokedAt}
                          onClick={() => setRevoking(key)}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Connect your first application"
            description="Create an expiring editor key restricted to the projects your application uses."
            action={<Button onClick={() => setCreating(true)}>Create API key</Button>}
          />
        )}
      </Section>
      {creating && (
        <KeyEditor
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setRevealed(key);
            list.reload();
            notify('API key created');
          }}
        />
      )}{' '}
      {revoking && (
        <Modal
          title={`Revoke “${revoking.name}”?`}
          description="Applications using this key will lose access immediately. Create and deploy a replacement first if you need uninterrupted ingestion."
          onClose={() => setRevoking(null)}
        >
          <ErrorBox message={action.error} />
          <div className="form-actions">
            <Button onClick={() => setRevoking(null)}>Keep key</Button>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await api(`/keys/${encodeURIComponent(revoking.id)}`, { method: 'DELETE' });
                  list.reload();
                  setRevoking(null);
                  setRevealed(null);
                  notify('API key revoked');
                })
              }
            >
              Revoke key
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function KeyEditor({
  projects,
  onClose,
  onCreated,
}: {
  projects: Project[];
  onClose: () => void;
  onCreated: (value: { key: string; name: string }) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('editor');
  const [projectIds, setProjectIds] = useState<string[] | null>([]);
  const [days, setDays] = useState(90);
  const action = useAction();
  return (
    <Modal
      title="Create an application key"
      description="The role and project scope are enforced on every request."
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
            const key = await post<WorkspaceApiKey & { key: string }>('/keys', {
              name,
              role,
              projectIds: role === 'admin' ? null : projectIds,
              expiresAt,
            });
            onCreated({ key: key.key, name: key.name });
          })
        }
      >
        <Field label="Key name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production agent ingestion"
          />
        </Field>
        <AccessFields
          role={role}
          setRole={setRole}
          projectIds={projectIds}
          setProjectIds={setProjectIds}
          projects={projects}
        />
        <Field label="Expires after">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
        </Field>
        {role === 'admin' && (
          <div className="warning-banner">
            Administrator keys can change team access and manage every project. Use an editor key
            for application ingestion.
          </div>
        )}
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Create API key" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
function AuditPanel() {
  const { refresh } = useWorkspace();
  const events = useData<AuditEvent[]>('/audit?limit=100', refresh);
  return (
    <Section
      title="Workspace audit log"
      detail="The latest 100 recorded access and mutation events. Payload contents are not included."
      actions={
        <Button onClick={events.reload}>
          <RefreshCw size={13} />
          Refresh
        </Button>
      }
    >
      <ErrorBox message={events.error} />
      {events.loading && !events.data ? (
        <Loading />
      ) : events.data?.length ? (
        <div className="table-wrap">
          <table className="access-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Project</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((event) => (
                <tr key={event.id}>
                  <td className="muted nowrap">{date(event.at)}</td>
                  <td>
                    <span className="code-tag">{event.action}</span>
                  </td>
                  <td>
                    <span className="scope-text">
                      {event.actorKind}
                      <small className="row-id">{event.actorId}</small>
                    </span>
                  </td>
                  <td>
                    <span className="row-id">{event.projectId || 'Workspace'}</span>
                  </td>
                  <td>
                    <Badge tone={event.statusCode < 400 ? 'green' : 'red'}>
                      {event.outcome} · {event.statusCode}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="No audit events yet"
          description="Access and mutation activity will appear here."
        />
      )}
    </Section>
  );
}

function ChangePassword() {
  const auth = useSession();
  const action = useAction();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  return (
    <Section
      title="Change your password"
      detail="Changing your password signs out every browser session for your account."
    >
      <Form
        permission="account"
        onSubmit={() =>
          action.run(async () => {
            if (newPassword !== confirmation) throw new Error('The new passwords do not match.');
            await post('/auth/change-password', { currentPassword, newPassword });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmation('');
            auth.endSession(
              'Password updated. Sign in with your new password. Previous browser sessions have been signed out.',
            );
          })
        }
      >
        <Field label="Current password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
        <Field label="New password" hint="Use at least 12 characters.">
          <input
            type="password"
            required
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            required
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </Field>
        <ErrorBox message={action.error} />
        <Button variant="primary" type="submit" permission="account" disabled={action.busy}>
          Update password
        </Button>
      </Form>
    </Section>
  );
}
