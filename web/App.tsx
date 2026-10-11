import { useEffect, useRef, useState } from 'react';
import { CommandMenu } from './command-menu';
import { LogsPage, TraceTable, TraceDrawer } from './observability';
export { TraceDrawer } from './observability';
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FlaskConical,
  Plug,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Terminal,
  Waypoints,
  X,
} from 'lucide-react';
import type { Experiment, Overview, Project } from '../shared/types';
import {
  WorkspaceContext,
  api,
  date,
  duration,
  money,
  numeric,
  percent,
  post,
  qs,
  shortDate,
  useAction,
  useData,
  useWorkspace,
} from './lib';
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
  Stat,
  Status,
} from './ui';
import { DatasetsPage, ExperimentsPage } from './evaluation';
import { PlaygroundPage, PromptsPage, ReviewPage, ScorersPage } from './tools';
import { SettingsPage, initials } from './access';
import { AuthBoundary, Brand } from './auth';
import { usePermissions, useSession } from './session';
import { IntegrationsPage } from './integrations';
import { PENDING_SDK_LINK_KEY, parseSdkExperimentLink, uniqueNamedResource } from './deep-links';
const navigation = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'logs', label: 'Logs', icon: Activity },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical },
  { id: 'datasets', label: 'Datasets', icon: Database },
  { id: 'prompts', label: 'Prompts', icon: MessageSquare },
  { id: 'playground', label: 'Playground', icon: Terminal },
  { id: 'scorers', label: 'Scorers', icon: ShieldCheck },
  { id: 'review', label: 'Review', icon: BookOpen },
  { id: 'integrations', label: 'Integrations', icon: Plug },
];
export default function App() {
  return (
    <AuthBoundary>
      <WorkspaceApp />
    </AuthBoundary>
  );
}
function WorkspaceApp() {
  const auth = useSession();
  const { canAdmin, canWrite } = usePermissions();
  const signOutAction = useAction();
  const [page, setPage] = useState(() => location.hash.slice(1) || 'overview');
  const [refresh, setRefresh] = useState(0);
  const projectPreference = `mindtrust-project-${auth.session.principal.id}`;
  const [projectId, setProjectId] = useState(() => sessionStorage.getItem(projectPreference) || '');
  useEffect(() => {
    if (projectId) sessionStorage.setItem(projectPreference, projectId);
  }, [projectId, projectPreference]);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [create, setCreate] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [commands, setCommands] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page, projectId]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommands((open) => !open);
      }
    };
    addEventListener('keydown', shortcut);
    return () => removeEventListener('keydown', shortcut);
  }, []);
  const [sdkLink, setSdkLink] = useState(() => {
    const direct = parseSdkExperimentLink(location.pathname);
    return direct.kind === 'none'
      ? parseSdkExperimentLink(sessionStorage.getItem(PENDING_SDK_LINK_KEY) || '')
      : direct;
  });
  const [sdkLinkError, setSdkLinkError] = useState('');
  const [linkedExperiment, setLinkedExperiment] = useState<{
    projectId: string;
    id: string;
  } | null>(null);
  const projects = useData<Project[]>('/projects', refresh);
  useEffect(() => {
    const handler = () => {
      clearSdkLink();
      setPage(location.hash.slice(1) || 'overview');
      setMobile(false);
    };
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    sessionStorage.removeItem(PENDING_SDK_LINK_KEY);
  }, []);
  useEffect(() => {
    if (sdkLink.kind === 'none') return;
    if (sdkLink.kind === 'invalid') {
      setSdkLinkError(sdkLink.message);
      return;
    }
    if (projects.loading || !projects.data) return;
    let active = true;
    setSdkLinkError('');
    void (async () => {
      try {
        const targetProject = uniqueNamedResource(projects.data!, sdkLink.projectName, 'project');
        const experiments = await api<Experiment[]>(
          `/experiments?${qs({ projectId: targetProject.id })}`,
        );
        const target = uniqueNamedResource(experiments, sdkLink.experimentName, 'experiment');
        if (!active) return;
        setProjectId(targetProject.id);
        setLinkedExperiment({ projectId: targetProject.id, id: target.id });
        setPage('experiments');
        history.replaceState(null, '', `${sdkLink.path}${location.search}#experiments`);
        setSdkLink({ kind: 'none' });
      } catch (e) {
        if (active) setSdkLinkError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [sdkLink, projects.data, projects.loading]);
  useEffect(() => {
    if (sdkLink.kind !== 'none') return;
    if (!projects.data || projects.loading) return;
    if (pendingProjectId) {
      if (projects.data.some((p) => p.id === pendingProjectId)) {
        setProjectId(pendingProjectId);
        setPendingProjectId(null);
      }
      return;
    }
    if (!projects.data.some((p) => p.id === projectId)) setProjectId(projects.data[0]?.id || '');
  }, [projects.data, projects.loading, projectId, pendingProjectId, sdkLink.kind]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  function navigate(id: string) {
    clearSdkLink();
    location.hash = id;
  }
  function clearSdkLink() {
    setSdkLink({ kind: 'none' });
    setSdkLinkError('');
    setLinkedExperiment(null);
    if (location.pathname.startsWith('/app/'))
      history.replaceState(null, '', `/${location.search}${location.hash}`);
  }
  const active = navigation.find((n) => n.id === page);
  const project = projects.data?.find((p) => p.id === projectId);
  const Page =
    (
      {
        overview: OverviewPage,
        logs: LogsPage,
        datasets: DatasetsPage,
        experiments: ExperimentsPage,
        prompts: PromptsPage,
        playground: PlaygroundPage,
        scorers: ScorersPage,
        review: ReviewPage,
        settings: SettingsPage,
        integrations: IntegrationsPage,
      } as Record<string, React.ComponentType>
    )[page] || OverviewPage;
  return (
    <WorkspaceContext.Provider
      value={{
        projectId,
        project,
        refresh,
        refreshAll: () => setRefresh((x) => x + 1),
        notify: setToast,
        navigate,
        openExperiment: (id) => {
          clearSdkLink();
          setLinkedExperiment({ projectId, id });
          setPage('experiments');
          history.replaceState(null, '', `${location.pathname}${location.search}#experiments`);
        },
      }}
    >
      <div className="app-shell">
        <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
          <Brand />
          <div className="workspace-picker">
            <label className="project-select">
              <span className="tiny-label">Project</span>
              <select
                aria-label="Current project"
                value={projectId}
                onChange={(e) => {
                  clearSdkLink();
                  setProjectId(e.target.value);
                }}
              >
                {projects.data?.length ? (
                  projects.data.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                ) : (
                  <option value="">No projects</option>
                )}
              </select>
              <ChevronDown size={13} />
            </label>
            <button
              disabled={!canAdmin}
              title={canAdmin ? 'Create a project' : 'An administrator can create projects'}
              className="icon-button"
              onClick={() => setCreate(true)}
              aria-label="Create a project"
            >
              <Plus size={15} />
            </button>
          </div>
          <button className="command-trigger" onClick={() => setCommands(true)}>
            <Search size={15} />
            <span>Jump to…</span>
            <kbd>⌘ K</kbd>
          </button>
          <nav aria-label="Main navigation">
            {[
              { label: 'Workspace', ids: ['overview', 'logs', 'experiments', 'review'] },
              { label: 'Build', ids: ['playground', 'prompts', 'datasets', 'scorers'] },
              { label: 'Configure', ids: ['integrations'] },
            ].map((group) => (
              <div key={group.label} className="nav-group">
                <div className="nav-section-label">{group.label}</div>
                {group.ids
                  .map((id) => navigation.find((n) => n.id === id)!)
                  .map(({ id, label, icon: Icon }) => (
                    <a
                      key={id}
                      href={`#${id}`}
                      className={`nav-link ${page === id ? 'active' : ''}`}
                      aria-current={page === id ? 'page' : undefined}
                    >
                      <Icon size={17} strokeWidth={1.7} />
                      {label}
                    </a>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <a
              href="#settings"
              className={`nav-link ${page === 'settings' ? 'active' : ''}`}
              aria-current={page === 'settings' ? 'page' : undefined}
            >
              <Settings size={17} />
              Settings & access
            </a>
            <div className="profile">
              <div className="avatar">{initials(auth.session.principal.name)}</div>
              <div>
                <strong>{auth.session.principal.name}</strong>
                <span>
                  {auth.session.principal.role} ·{' '}
                  {auth.session.principal.projectIds === null
                    ? 'All projects'
                    : `${auth.session.principal.projectIds.length} ${auth.session.principal.projectIds.length === 1 ? 'project' : 'projects'}`}
                </span>
              </div>
            </div>
          </div>
        </aside>
        {mobile && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          />
        )}
        <div className="app-main">
          <div className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-toggle"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <Menu size={20} />
              </button>
              <span className="breadcrumb-workspace">Verus</span>
              <ChevronRight size={13} />
              <span>{active?.label || 'Settings'}</span>
            </div>
            <div className="topbar-right">
              <span className="connection">
                {auth.status.enabled ? 'Private workspace' : 'Local'}
              </span>
              <button
                className="icon-button"
                onClick={() => setRefresh((x) => x + 1)}
                aria-label="Refresh data"
              >
                <RefreshCw size={15} />
              </button>
              {auth.status.enabled && (
                <button
                  className="icon-button"
                  aria-label="Sign out"
                  title="Sign out"
                  disabled={signOutAction.busy}
                  onClick={() => signOutAction.run(auth.signOut)}
                >
                  <LogOut size={15} />
                </button>
              )}
            </div>
          </div>
          <main key={projectId} ref={contentRef} className="main-content" data-page={page}>
            <ErrorBox message={signOutAction.error} />
            {projects.error && <ErrorBox message={projects.error} />}
            {!canWrite && (
              <div className="permission-banner">
                <ShieldCheck size={15} />
                <span>
                  You have viewer access. You can inspect and export data; changes require an editor
                  or administrator.
                </span>
              </div>
            )}
            {sdkLink.kind !== 'none' ? (
              sdkLinkError || projects.error ? (
                <Section title="Unable to open this SDK link">
                  <div className="integration-section-body">
                    <ErrorBox message={sdkLinkError || projects.error} />
                    <Button onClick={() => navigate('experiments')}>
                      Browse accessible experiments
                    </Button>
                  </div>
                </Section>
              ) : (
                <Loading />
              )
            ) : page === 'settings' || page === 'integrations' ? (
              <Page />
            ) : projects.loading && !projects.data ? (
              <Loading />
            ) : !projectId || projects.data?.length === 0 ? (
              <WorkspaceOnboarding
                canCreate={canAdmin}
                onCreate={() => setCreate(true)}
                onSettings={() => navigate('settings')}
              />
            ) : page === 'experiments' ? (
              <ExperimentsPage
                linkedExperimentId={
                  linkedExperiment?.projectId === projectId ? linkedExperiment.id : undefined
                }
                onLeaveLinkedExperiment={clearSdkLink}
              />
            ) : (
              <Page />
            )}
          </main>
        </div>
        {toast && (
          <div className="toast" role="status">
            <Check size={17} />
            {toast}
            <button aria-label="Dismiss notification" onClick={() => setToast('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {commands && (
          <CommandMenu
            pages={[...navigation, { id: 'settings', label: 'Settings & access', icon: Settings }]}
            projects={projects.data || []}
            navigate={navigate}
            selectProject={(id) => {
              clearSdkLink();
              setProjectId(id);
              setMobile(false);
            }}
            onClose={() => setCommands(false)}
          />
        )}
        {create && (
          <CreateProject
            onClose={() => setCreate(false)}
            onCreated={(p) => {
              setPendingProjectId(p.id);
              setProjectId(p.id);
              setRefresh((x) => x + 1);
              setCreate(false);
              setToast('Project created');
            }}
          />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceOnboarding({
  canCreate,
  onCreate,
  onSettings,
}: {
  canCreate: boolean;
  onCreate: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="workspace-onboarding">
      <div className="eyebrow">A WORKSPACE FOR YOUR TEAM</div>
      <h1>{canCreate ? 'Start with your first project.' : 'Your workspace is ready.'}</h1>
      <p>
        {canCreate
          ? 'Keep an application’s traces, evaluation datasets, and experiment history together.'
          : 'An administrator can assign projects to your account. You’ll see those projects here as soon as access is granted.'}
      </p>
      <div className="onboarding-cards">
        <div>
          <span className="onboarding-number">01</span>
          <Database size={22} />
          <h3>{canCreate ? 'Create a project' : 'Get project access'}</h3>
          <p>
            {canCreate
              ? 'Choose a name for the agent or application your team is building.'
              : 'Ask your workspace administrator to assign the projects you need.'}
          </p>
          {canCreate && (
            <Button variant="primary" onClick={onCreate}>
              <Plus size={14} />
              Create project
            </Button>
          )}
        </div>
        <div>
          <span className="onboarding-number">02</span>
          <Plug size={22} />
          <h3>Connect your application</h3>
          <p>
            Use scoped API keys with the supported Braintrust SDK, native ingestion, or
            OpenTelemetry JSON.
          </p>
          <Badge>After project setup</Badge>
        </div>
        <div>
          <span className="onboarding-number">03</span>
          <ShieldCheck size={22} />
          <h3>Give your team access</h3>
          <p>Assign viewer, editor, and administrator roles in workspace settings.</p>
          <Button onClick={onSettings}>
            View workspace access
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
function CreateProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const action = useAction();
  return (
    <Modal
      title="Create a project"
      description="Keep traces, datasets, and evaluations together."
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          action.run(async () => onCreated(await post<Project>('/projects', { name, description })))
        }
      >
        <Field label="Project name">
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Customer support agent"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you building?"
          />
        </Field>
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Create project" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
function OverviewPage() {
  const { projectId, refresh, navigate, openExperiment } = useWorkspace();
  const [traceId, setTraceId] = useState<string | null>(null);
  const [recentView, setRecentView] = useState<'traces' | 'experiments'>('traces');
  const { data, loading, error } = useData<Overview>(`/overview?${qs({ projectId })}`, refresh);
  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <Button onClick={() => navigate('integrations')}>
            <Plug size={15} />
            Connect app
          </Button>
        }
      />
      {projectId === 'demo-project' && (
        <div className="demo-banner">
          <span>Demo data · Synthetic traces and evaluations</span>
        </div>
      )}
      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="stats-grid overview-metrics">
              <Stat
                label="Total traces"
                value={numeric(data.traceCount)}
                detail={<>{numeric(data.traceCount - data.errorCount)} successful runs</>}
                icon={<Activity size={17} />}
              />
              <Stat
                label="Error rate"
                value={percent(data.errorRate)}
                detail={`${numeric(data.errorCount)} runs need attention`}
                icon={<ShieldCheck size={17} />}
              />
              <Stat
                label="P50 latency"
                value={duration(data.p50LatencyMs)}
                detail={`P95 ${duration(data.p95LatencyMs)}`}
                icon={<Waypoints size={17} />}
              />
              <Stat
                label="Recorded model spend"
                value={money(
                  data.traceCount > 0 && data.unknownCostCount === data.traceCount
                    ? null
                    : data.knownCostUsd,
                )}
                detail={
                  data.unknownCostCount
                    ? `${data.unknownCostCount} runs have unknown cost`
                    : `${numeric(data.totalTokens)} tokens across runs`
                }
                icon={<Code2 size={17} />}
              />
            </div>
            <div className="overview-charts">
              <Section
                title="Trace activity"
                actions={
                  <div className="chart-legend">
                    <span>Traces</span>
                    <span>
                      <i className="red" />
                      Errors
                    </span>
                  </div>
                }
              >
                <ActivityChart series={data.series} />
              </Section>
              <Section title="Model usage" className="model-panel">
                <div className="model-total">
                  {numeric(data.totalTokens)}
                  <span>total tokens</span>
                </div>
                <div className="model-list">
                  {data.models.length ? (
                    data.models.map((m, i) => (
                      <div key={m.model} className="model-row">
                        <div className="model-row-head">
                          <span>
                            <i
                              style={{
                                background: [
                                  'var(--chart-1)',
                                  'var(--chart-2)',
                                  'var(--chart-3)',
                                  'var(--chart-4)',
                                ][i % 4],
                              }}
                            />
                            {m.model || 'Unspecified'}
                          </span>
                          <strong>{numeric(m.tokens)}</strong>
                        </div>
                        <div className="model-bar">
                          <i
                            style={{
                              width: `${Math.max(2, (m.tokens / Math.max(1, data.totalTokens)) * 100)}%`,
                              background: [
                                'var(--chart-1)',
                                'var(--chart-2)',
                                'var(--chart-3)',
                                'var(--chart-4)',
                              ][i % 4],
                            }}
                          />
                        </div>
                        <span className="muted small-text">
                          {numeric(m.traces)} traces · {money(m.costUsd)} recorded
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Model usage appears when you send traces.</p>
                  )}
                </div>
              </Section>
            </div>
            <section className="panel recent-activity">
              <div className="panel-head">
                <div className="activity-tabs" role="group" aria-label="Recent activity">
                  <button
                    aria-pressed={recentView === 'traces'}
                    onClick={() => setRecentView('traces')}
                  >
                    Recent traces
                  </button>
                  <button
                    aria-pressed={recentView === 'experiments'}
                    onClick={() => setRecentView('experiments')}
                  >
                    Experiments
                  </button>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => navigate(recentView === 'traces' ? 'logs' : 'experiments')}
                >
                  View all <ArrowRight size={14} />
                </Button>
              </div>
              {recentView === 'traces' ? (
                <TraceTable traces={data.recentTraces.slice(0, 5)} onSelect={setTraceId} />
              ) : (
                <>
                  {data.recentExperiments.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Experiment</th>
                            <th>Status</th>
                            <th>Cases</th>
                            <th title="Mean across the recorded score metrics">Mean score</th>
                            <th>Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.recentExperiments.slice(0, 5).map((e) => {
                            const scores = Object.values(e.scores).filter(
                              (s): s is number => s !== null,
                            );
                            return (
                              <tr key={e.id}>
                                <td>
                                  <button
                                    className="row-title"
                                    onClick={() => openExperiment(e.id)}
                                  >
                                    <span className="table-icon">
                                      <FlaskConical size={14} />
                                    </span>
                                    {e.name}
                                  </button>
                                </td>
                                <td>
                                  <Status value={e.status} />
                                </td>
                                <td className="tabular">
                                  {e.completedCases} / {e.totalCases}
                                </td>
                                <td>
                                  <Score
                                    value={
                                      scores.length
                                        ? scores.reduce((a, b) => a + b, 0) / scores.length
                                        : null
                                    }
                                  />
                                </td>
                                <td className="muted">{date(e.createdAt)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      title="Your first experiment starts here"
                      description="Create a dataset and test how your agent performs."
                      action={
                        <Button onClick={() => navigate('datasets')}>Create a dataset</Button>
                      }
                    />
                  )}
                </>
              )}
            </section>
          </>
        )
      )}
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}
    </>
  );
}
function ActivityChart({ series }: { series: Overview['series'] }) {
  if (!series.length)
    return (
      <Empty title="No activity yet" description="Send your first traces to see activity here." />
    );
  const max = Math.max(1, ...series.map((s) => s.traces));
  const width = 800,
    height = 155;
  const barWidth = Math.min(35, ((width - 40) / series.length) * 0.48);
  const x = (i: number) => 32 + ((i + 0.5) / series.length) * (width - 50);
  const y = (n: number) => height - 15 - (n / max) * (height - 40);
  return (
    <div className="activity-chart">
      <svg
        viewBox={`0 0 ${width} ${height + 28}`}
        role="img"
        aria-label={`${series.reduce((n, s) => n + s.traces, 0)} traces over ${series.length} recorded days`}
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line
              x1="32"
              x2={width}
              y1={y(max * v)}
              y2={y(max * v)}
              stroke="var(--line)"
              strokeDasharray="3 4"
            />
            <text x="22" y={y(max * v) + 4} textAnchor="end" className="chart-label">
              {Math.round(max * v)}
            </text>
          </g>
        ))}
        {series.map((s, i) => (
          <g key={s.date}>
            <rect
              x={x(i) - barWidth / 2}
              y={y(s.traces)}
              width={barWidth}
              height={Math.max(1, height - 15 - y(s.traces))}
              rx="3"
              fill="var(--chart-1)"
            >
              <title>
                {s.date}: {s.traces} traces, {s.errors} errors
              </title>
            </rect>
            {s.errors > 0 && (
              <rect
                x={x(i) - barWidth / 2}
                y={y(s.errors)}
                width={barWidth}
                height={height - 15 - y(s.errors)}
                rx="2"
                fill="var(--red)"
              />
            )}
            {(series.length < 10 || i % Math.ceil(series.length / 7) === 0) && (
              <text x={x(i)} y={height + 15} textAnchor="middle" className="chart-label">
                {shortDate(s.date)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
export function Score({
  value,
  delta = false,
}: {
  value: number | null | undefined;
  delta?: boolean;
}) {
  return (
    <span
      className={`score ${value == null ? '' : delta ? (value > 0 ? 'good' : value < 0 ? 'bad' : '') : value >= 0.8 ? 'good' : value < 0.5 ? 'bad' : 'medium'}`}
    >
      {delta && value != null && value > 0 ? '+' : ''}
      {delta && value != null ? `${(value * 100).toFixed(1)} pp` : percent(value)}
    </span>
  );
}
