import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  FlaskConical,
  Layers3,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Waypoints,
  X,
} from 'lucide-react';
import type {
  Dataset,
  Overview,
  Project,
  ServerInfo,
  Span,
  Trace,
  TraceDetail,
} from '../shared/types';
import {
  WorkspaceContext,
  api,
  compact,
  date,
  download,
  duration,
  money,
  numeric,
  parseJson,
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
  JsonBlock,
  Loading,
  Modal,
  PageHeader,
  Section,
  Stat,
  Status,
} from './ui';
import { DatasetsPage, ExperimentsPage } from './evaluation';
import { PlaygroundPage, PromptsPage, ReviewPage, ScorersPage, SettingsPage } from './tools';
const navigation = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'logs', label: 'Logs', icon: Activity },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical },
  { id: 'datasets', label: 'Datasets', icon: Database },
  { id: 'prompts', label: 'Prompts', icon: MessageSquare },
  { id: 'playground', label: 'Playground', icon: Terminal },
  { id: 'scorers', label: 'Scorers', icon: ShieldCheck },
  { id: 'review', label: 'Review', icon: BookOpen },
];
export default function App() {
  const [page, setPage] = useState(() => location.hash.slice(1) || 'overview');
  const [refresh, setRefresh] = useState(0);
  const [projectId, setProjectId] = useState('demo-project');
  const [toast, setToast] = useState('');
  const [create, setCreate] = useState(false);
  const [mobile, setMobile] = useState(false);
  const projects = useData<Project[]>('/projects', refresh);
  const info = useData<ServerInfo>('/info', refresh);
  useEffect(() => {
    const handler = () => {
      setPage(location.hash.slice(1) || 'overview');
      setMobile(false);
    };
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (
      projects.data?.length &&
      projectId === 'demo-project' &&
      !projects.data.some((p) => p.id === projectId)
    )
      setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  function navigate(id: string) {
    location.hash = id;
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
      }}
    >
      <div className="app-shell">
        <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
          <a className="brand" href="#overview" aria-label="MindTrust home">
            <span className="brand-symbol">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 18V6l8 8 8-8v12"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>
              mindtrust<span className="brand-period">.</span>
            </span>
          </a>
          <div className="workspace-picker">
            <div className="workspace-mark">P</div>
            <div>
              <span className="tiny-label">WORKSPACE</span>
              <strong>PreMan</strong>
            </div>
            <Badge>Local</Badge>
          </div>
          <div className="nav-section-label">BUILD WITH CONFIDENCE</div>
          <nav aria-label="Main navigation">
            {navigation.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                className={`nav-link ${page === id ? 'active' : ''}`}
                aria-current={page === id ? 'page' : undefined}
              >
                <Icon size={17} strokeWidth={1.7} />
                {label}
                {page === id && <span className="nav-active-dot" />}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-note">
              <div className="local-note-icon">
                <Layers3 size={16} />
              </div>
              <strong>Your stack. Your data.</strong>
              <p>Infrastructure for better agents.</p>
              <a href="https://github.com/PreMan-Inc/MindTrust" target="_blank" rel="noreferrer">
                Explore the source <ArrowRight size={13} />
              </a>
            </div>
            <a href="#settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`}>
              <Settings size={17} />
              Settings & API keys
            </a>
            <div className="profile">
              <div className="avatar">MT</div>
              <div>
                <strong>MindTrust workspace</strong>
                <span>Built by PreMan · v{info.data?.version || '0.1'}</span>
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
              <span className="breadcrumb-workspace">Workspace</span>
              <ChevronRight size={14} />
              <label className="project-select">
                <select
                  aria-label="Current project"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                  }}
                >
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  )) || <option value="demo-project">Select project</option>}
                </select>
                <ChevronDown size={13} />
              </label>
              <button
                className="icon-button"
                onClick={() => setCreate(true)}
                aria-label="Create a project"
              >
                <Plus size={15} />
              </button>
              <span className="breadcrumb-divider">/</span>
              <span>{active?.label || 'Settings'}</span>
            </div>
            <div className="topbar-right">
              <span className="connection">
                <i />
                Local workspace
              </span>
              <button
                className="icon-button"
                onClick={() => setRefresh((x) => x + 1)}
                aria-label="Refresh data"
              >
                <RefreshCw size={15} />
              </button>
              <span className="avatar small">P</span>
            </div>
          </div>
          <main key={projectId} className="main-content">
            {projects.error && page !== 'settings' && (
              <div className="auth-warning">
                <ErrorBox message={projects.error} />
                <Button onClick={() => navigate('settings')}>Configure access</Button>
              </div>
            )}
            {projects.data?.length === 0 && page !== 'settings' ? (
              <Empty
                title="Create your first project"
                description="Start with a project to collect your traces, datasets, and experiments."
                action={
                  <Button variant="primary" onClick={() => setCreate(true)}>
                    <Plus size={15} />
                    Create project
                  </Button>
                }
              />
            ) : (
              <Page />
            )}
          </main>
          <footer className="app-footer">
            <span>MindTrust · Agent observability & evaluations</span>
            <span>
              <i className="footer-dot" />
              Local SQLite storage
            </span>
          </footer>
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
        {create && (
          <CreateProject
            onClose={() => setCreate(false)}
            onCreated={(p) => {
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
  const { projectId, project, refresh, navigate } = useWorkspace();
  const { data, loading, error } = useData<Overview>(`/overview?${qs({ projectId })}`, refresh);
  return (
    <>
      <PageHeader
        eyebrow="EVERY RUN TELLS A STORY"
        title="A clearer view of your agents."
        description={`Monitor ${project?.name || 'your project'}, understand failures, and turn what you learn into better evaluations.`}
        actions={
          <Button variant="primary" onClick={() => navigate('experiments')}>
            <FlaskConical size={16} />
            Run an evaluation <ArrowRight size={15} />
          </Button>
        }
      />
      {projectId === 'demo-project' && (
        <div className="demo-banner">
          <Sparkles size={16} />
          <span>
            <strong>A workspace to explore.</strong> All sample runs and metrics below are
            synthetic. No model calls were made.
          </span>
          <button onClick={() => navigate('settings')}>
            Connect your application <ArrowRight size={13} />
          </button>
        </div>
      )}
      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="stats-grid">
              <Stat
                label="Total traces"
                value={numeric(data.traceCount)}
                detail={
                  <>
                    <span className="mini-dot green-dot" />
                    {numeric(data.traceCount - data.errorCount)} successful runs
                  </>
                }
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
                label="Known model spend"
                value={money(data.knownCostUsd)}
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
                title="Activity at a glance"
                detail="Trace volume across the recorded period"
                actions={
                  <div className="chart-legend">
                    <span>
                      <i />
                      Traces
                    </span>
                    <span>
                      <i className="red" />
                      Errors
                    </span>
                  </div>
                }
              >
                <ActivityChart series={data.series} />
              </Section>
              <Section title="Model usage" detail="Where your tokens go" className="model-panel">
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
                                background: ['#547e42', '#a3bf8a', '#cbd9ba', '#303b32'][i % 4],
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
                              background: ['#547e42', '#a3bf8a', '#cbd9ba', '#303b32'][i % 4],
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
            <Section
              title="Recent experiments"
              detail="Track progress. Catch regressions before they ship."
              actions={
                <Button variant="ghost" onClick={() => navigate('experiments')}>
                  All experiments <ArrowRight size={14} />
                </Button>
              }
            >
              {data.recentExperiments.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Experiment</th>
                        <th>Status</th>
                        <th>Cases</th>
                        <th>Avg. score</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentExperiments.map((e) => {
                        const scores = Object.values(e.scores).filter(
                          (s): s is number => s !== null,
                        );
                        return (
                          <tr key={e.id}>
                            <td>
                              <button className="row-title" onClick={() => navigate('experiments')}>
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
                  action={<Button onClick={() => navigate('datasets')}>Create a dataset</Button>}
                />
              )}
            </Section>
            <Section
              title="Recent traces"
              actions={
                <Button variant="ghost" onClick={() => navigate('logs')}>
                  Explore logs <ArrowRight size={14} />
                </Button>
              }
            >
              <TraceTable traces={data.recentTraces} onSelect={() => navigate('logs')} />
            </Section>
            <div className="bottom-note">
              <span className="mini-dot green-dot" />
              Inspect the recorded runs behind your metrics.
            </div>
          </>
        )
      )}
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
    height = 190;
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
              stroke="#e9ece6"
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
              fill="#b8d39f"
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
                fill="#d58779"
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
export function TraceTable({
  traces,
  onSelect,
}: {
  traces: Trace[];
  onSelect: (id: string) => void;
}) {
  return traces.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Trace</th>
            <th>Status</th>
            <th>Model</th>
            <th>Duration</th>
            <th>Cost</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id}>
              <td>
                <button className="row-title" onClick={() => onSelect(t.id)}>
                  <span className={`trace-symbol ${t.status}`}>
                    <Waypoints size={15} />
                  </span>
                  <span>
                    {t.name}
                    <small>{t.id.slice(0, 18)}</small>
                  </span>
                </button>
              </td>
              <td>
                <Status value={t.status} />
              </td>
              <td>
                <span className="code-tag">{t.model || '—'}</span>
              </td>
              <td className="tabular">{duration(t.latencyMs)}</td>
              <td className="tabular">{money(t.costUsd)}</td>
              <td className="muted nowrap">{date(t.startTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="No traces found"
      description="Try changing your filters, or connect your application."
    />
  );
}
export function LogsPage() {
  const { projectId, refresh, notify } = useWorkspace();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const { data, loading, error } = useData<{ items: Trace[]; total: number }>(
    `/traces?${qs({ projectId, search: query, status, limit: 25, offset })}`,
    refresh,
  );
  return (
    <>
      <PageHeader
        eyebrow="OBSERVABILITY"
        title="Understand every run."
        description="Follow your agents from the first request to the final answer."
        actions={
          <Button
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await download(`/traces/export?${qs({ projectId })}`, 'mindtrust-traces.json');
                notify('Traces exported');
              })
            }
          >
            <ArrowDownToLine size={15} />
            Export traces
          </Button>
        }
      />
      <ErrorBox message={action.error || error} />
      <div className="panel">
        <div className="filter-bar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="Search traces"
              placeholder="Search traces, inputs, outputs, or tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => setSearch('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select
            aria-label="Filter trace status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            <option value="ok">Successful</option>
            <option value="error">Errors</option>
          </select>
          <span className="count-label">{data?.total ?? '—'} traces</span>
        </div>
        {loading && !data ? (
          <Loading />
        ) : (
          <TraceTable traces={data?.items || []} onSelect={setSelected} />
        )}
        <div className="table-footer">
          <span>
            {data?.total
              ? `${offset + 1}–${Math.min(offset + 25, data.total)} of ${data.total} traces`
              : 'No results'}
          </span>
          <div>
            <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
              <ChevronLeft size={14} />
              Previous
            </Button>
            <Button
              disabled={!data || offset + 25 >= data.total}
              onClick={() => setOffset(offset + 25)}
            >
              Next
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>
      {selected && <TraceDrawer id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
export function TraceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const detail = useData<TraceDetail>(`/traces/${encodeURIComponent(id)}`, refresh);
  const datasets = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const [tab, setTab] = useState('spans');
  const [spanId, setSpanId] = useState<string | null>(null);
  const [label, setLabel] = useState('correct');
  const [comment, setComment] = useState('');
  const [expected, setExpected] = useState('null');
  const [datasetId, setDatasetId] = useState('');
  const [datasetExpected, setDatasetExpected] = useState('');
  const action = useAction();
  const trace = detail.data?.trace;
  const spans = detail.data?.spans || [];
  const span = spans.find((s) => s.id === spanId);
  const content = span || trace;
  return (
    <Modal title={trace?.name || 'Trace detail'} description={id} onClose={onClose} drawer>
      <ErrorBox message={detail.error || action.error} />
      {detail.loading && !trace ? (
        <Loading />
      ) : (
        trace && (
          <>
            <div className="trace-summary">
              <Status value={trace.status} />
              <span>{duration(trace.latencyMs)}</span>
              <span>{numeric(trace.inputTokens + trace.outputTokens)} tokens</span>
              <span>{money(trace.costUsd)}</span>
            </div>
            <div className="tabs" role="tablist" aria-label="Trace views">
              {['spans', 'input & output', 'metadata', 'review'].map((t) => (
                <button
                  role="tab"
                  aria-selected={tab === t}
                  key={t}
                  className={tab === t ? 'active' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === 'spans' && (
              <>
                <div className="waterfall-head">
                  <span>Span hierarchy</span>
                  <span>Duration</span>
                </div>
                <div className="span-list">
                  {spans.length ? (
                    orderedSpans(spans).map(({ span: s, depth }) => {
                      const total = Math.max(1, trace.latencyMs);
                      const start =
                        new Date(s.startTime).getTime() - new Date(trace.startTime).getTime();
                      const time = new Date(s.endTime).getTime() - new Date(s.startTime).getTime();
                      return (
                        <button
                          key={s.id}
                          className={`span-row ${spanId === s.id ? 'selected' : ''}`}
                          onClick={() => setSpanId(spanId === s.id ? null : s.id)}
                          style={{ paddingLeft: `${12 + Math.min(depth, 8) * 14}px` }}
                        >
                          <span className="span-name">
                            <span className={`span-kind ${s.kind}`}>
                              <Code2 size={12} />
                            </span>
                            {s.name}
                            <small>{s.kind}</small>
                          </span>
                          <span className="waterfall-track">
                            <i
                              className={s.status === 'error' ? 'error' : ''}
                              style={{
                                marginLeft: `${Math.min(95, Math.max(0, (start / total) * 100))}%`,
                                width: `${Math.min(100, Math.max(2, (time / total) * 100))}%`,
                              }}
                            />
                          </span>
                          <span className="tabular">{duration(time)}</span>
                        </button>
                      );
                    })
                  ) : (
                    <Empty
                      title="Root trace only"
                      description="Send nested spans to inspect the full execution tree."
                    />
                  )}
                </div>
                {span && (
                  <div className="span-detail">
                    <div className="subheading">
                      <h3>{span.name}</h3>
                      <Status value={span.status} />
                    </div>
                    <JsonBlock value={span.input} label="Input" />
                    <JsonBlock value={span.output} label="Output" />
                    <JsonBlock value={span.metadata} label="Span metadata" />
                  </div>
                )}
              </>
            )}
            {tab === 'input & output' && (
              <>
                <JsonBlock value={trace.input} label="Input" />
                <JsonBlock value={trace.output} label="Output" />
              </>
            )}
            {tab === 'metadata' && (
              <>
                <div className="key-value">
                  <span>Started</span>
                  <strong>{date(trace.startTime)}</strong>
                  <span>Model</span>
                  <strong>{trace.model || 'Unknown'}</strong>
                  <span>Input / output tokens</span>
                  <strong>
                    {trace.inputTokens} / {trace.outputTokens}
                  </strong>
                  <span>Tags</span>
                  <strong>{trace.tags.join(', ') || 'None'}</strong>
                </div>
                <JsonBlock value={trace.metadata} label="Metadata" />
              </>
            )}
            {tab === 'review' && (
              <>
                <Form
                  onSubmit={() =>
                    action.run(async () => {
                      await post('/annotations', {
                        projectId,
                        targetType: 'trace',
                        targetId: id,
                        label,
                        comment,
                        expected: parseJson(expected, 'Expected output'),
                      });
                      setComment('');
                      refreshAll();
                      notify('Review saved');
                    })
                  }
                >
                  <Field label="Evaluation">
                    <select value={label} onChange={(e) => setLabel(e.target.value)}>
                      <option value="correct">Correct</option>
                      <option value="incorrect">Incorrect</option>
                      <option value="needs_review">Needs review</option>
                    </select>
                  </Field>
                  <Field label="Comment">
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="What should the team know?"
                    />
                  </Field>
                  <Field label="Expected output (JSON)">
                    <textarea
                      className="code-input"
                      value={expected}
                      onChange={(e) => setExpected(e.target.value)}
                    />
                  </Field>
                  <FormActions busy={action.busy} label="Save review" />
                </Form>
                <div className="annotation-list">
                  {detail.data?.annotations.map((a) => (
                    <div className="annotation" key={a.id}>
                      <div>
                        <Status value={a.label} />
                        <span>{date(a.createdAt)}</span>
                      </div>
                      <p>{a.comment || 'No comment'}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="drawer-dataset">
              <div>
                <Database size={16} />
                <strong>Turn this run into a test</strong>
              </div>
              <p>
                Save this input with an explicitly reviewed expected output. The actual output is
                never used automatically.
              </p>
              <Field
                label="Expected output (JSON)"
                hint="Review and enter the correct answer. Use null if the correct value is null."
              >
                <textarea
                  className="code-input"
                  value={datasetExpected}
                  onChange={(e) => setDatasetExpected(e.target.value)}
                  placeholder='"The correct answer"'
                />
              </Field>
              <div className="inline-form" style={{ marginTop: 12 }}>
                <select
                  aria-label="Destination dataset"
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                >
                  <option value="">Select a dataset</option>
                  {datasets.data?.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={!datasetId || !datasetExpected.trim() || action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await post(`/datasets/${encodeURIComponent(datasetId)}/rows`, {
                        rows: [
                          {
                            input: trace.input,
                            expected: parseJson(datasetExpected, 'Expected output'),
                            metadata: { sourceTraceId: trace.id },
                            tags: trace.tags,
                          },
                        ],
                      });
                      refreshAll();
                      notify('Trace added to dataset');
                    })
                  }
                >
                  <Plus size={14} />
                  Add
                </Button>
              </div>
            </div>
          </>
        )
      )}
    </Modal>
  );
}
function orderedSpans(spans: Span[]) {
  const results: { span: Span; depth: number }[] = [];
  const visited = new Set<string>();
  const ids = new Set(spans.map((s) => s.id));
  function walk(parent: string | null, depth: number) {
    spans
      .filter((s) => s.parentId === parent)
      .forEach((s) => {
        if (visited.has(s.id)) return;
        visited.add(s.id);
        results.push({ span: s, depth });
        walk(s.id, depth + 1);
      });
  }
  spans
    .filter((s) => !s.parentId || !ids.has(s.parentId))
    .forEach((s) => {
      if (!visited.has(s.id)) {
        visited.add(s.id);
        results.push({ span: s, depth: 0 });
        walk(s.id, 1);
      }
    });
  spans.filter((s) => !visited.has(s.id)).forEach((s) => results.push({ span: s, depth: 0 }));
  return results;
}
