import { useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Code2,
  Columns3,
  Copy,
  Database,
  Expand,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Waypoints,
  X,
} from 'lucide-react';
import type { Dataset, Json, Span, Trace, TraceDetail } from '../shared/types';
import {
  compact,
  copy,
  date,
  download,
  duration,
  money,
  numeric,
  parseJson,
  post,
  qs,
  useAction,
  useData,
  useWorkspace,
} from './lib';
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  Form,
  FormActions,
  Loading,
  Modal,
  PageHeader,
  Status,
} from './ui';
import { usePermissions } from './session';
import { orderedSpans, resolveDatasetSource } from './observability-model';
import './observability.css';

export type TraceSort = 'name' | 'startTime' | 'latencyMs' | 'costUsd' | 'tokens' | 'spanCount';
type TraceColumn = 'status' | 'model' | 'latencyMs' | 'tokens' | 'costUsd' | 'startTime';
const columnLabels: Record<TraceColumn, string> = {
  status: 'Status',
  model: 'Model',
  latencyMs: 'Duration',
  tokens: 'Tokens',
  costUsd: 'Cost',
  startTime: 'Started',
};
const defaultColumns = Object.keys(columnLabels) as TraceColumn[];
const sortLabels: Record<TraceSort, string> = {
  name: 'Name',
  startTime: 'Start time',
  latencyMs: 'Duration',
  costUsd: 'Cost',
  tokens: 'Tokens',
  spanCount: 'Spans',
};

/** Kept compatible with the dashboard table; sorting is controlled by the calling page. */
export function TraceTable({
  traces,
  onSelect,
  selectedId,
  sort = 'startTime',
  direction = 'desc',
  onSort,
  columns = defaultColumns,
  dense = false,
}: {
  traces: Trace[];
  onSelect: (id: string) => void;
  selectedId?: string | null;
  sort?: TraceSort;
  direction?: 'asc' | 'desc';
  onSort?: (sort: TraceSort) => void;
  columns?: TraceColumn[];
  dense?: boolean;
}) {
  const visibleColumns = defaultColumns.filter((column) => columns.includes(column));
  const maxDuration = Math.max(1, ...traces.map((trace) => trace.latencyMs));
  function heading(label: string, key?: TraceSort) {
    return key && onSort ? (
      <button className={`obs-sort ${sort === key ? 'is-sorted' : ''}`} onClick={() => onSort(key)}>
        {label}
        {sort === key ? (
          direction === 'asc' ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : (
          <ArrowUpDown size={11} />
        )}
      </button>
    ) : (
      label
    );
  }
  function rowKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowDown'
        ? traces[index + 1]
        : event.key === 'ArrowUp'
          ? traces[index - 1]
          : null;
    if (next) {
      event.preventDefault();
      onSelect(next.id);
      const table = event.currentTarget.closest('table');
      const buttons = table?.querySelectorAll<HTMLButtonElement>('.obs-trace-name');
      buttons?.[event.key === 'ArrowDown' ? index + 1 : index - 1]?.focus();
    }
  }
  return traces.length ? (
    <div className={`obs-table-scroll ${dense ? 'obs-dense' : ''}`}>
      <table className="obs-table">
        <thead>
          <tr>
            <th
              className="obs-name-column"
              aria-sort={
                sort === 'name' ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
              }
            >
              {heading('Name', 'name')}
            </th>
            {visibleColumns.map((column) => (
              <th
                key={column}
                className={`obs-col-${column}`}
                aria-sort={
                  sort === column ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
                }
              >
                {heading(
                  columnLabels[column],
                  column === 'model' || column === 'status' ? undefined : column,
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {traces.map((trace, index) => (
            <tr
              key={trace.id}
              className={trace.id === selectedId ? 'obs-selected-row' : ''}
              onClick={() => onSelect(trace.id)}
            >
              <td className="obs-name-column">
                <button
                  className="obs-trace-name"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(trace.id);
                  }}
                  onKeyDown={(event) => rowKeys(event, index)}
                  aria-current={trace.id === selectedId ? 'true' : undefined}
                >
                  <span className={`obs-run-symbol ${trace.status}`}>
                    <Waypoints size={14} />
                  </span>
                  <span className="obs-run-label">
                    <strong title={trace.name}>{trace.name}</strong>
                    <small>
                      <code>{trace.id.slice(0, 8)}</code>
                      <span>·</span>
                      {trace.spanCount} {trace.spanCount === 1 ? 'span' : 'spans'}
                    </small>
                  </span>
                  <ChevronRight size={13} className="obs-row-arrow" />
                </button>
              </td>
              {columns.includes('status') && (
                <td className="obs-col-status">
                  <Status value={trace.status} />
                </td>
              )}
              {columns.includes('model') && (
                <td className="obs-col-model">
                  <span className="obs-model" title={trace.model || 'Model not recorded'}>
                    {trace.model || '—'}
                  </span>
                </td>
              )}
              {columns.includes('latencyMs') && (
                <td className="obs-col-latencyMs">
                  <div className="obs-duration">
                    <span>{duration(trace.latencyMs)}</span>
                    <i
                      style={
                        {
                          '--duration': `${Math.max(2, (trace.latencyMs / maxDuration) * 100)}%`,
                        } as CSSProperties
                      }
                    />
                  </div>
                </td>
              )}
              {columns.includes('tokens') && (
                <td
                  className="obs-col-tokens obs-number"
                  title={`${trace.inputTokens.toLocaleString()} input / ${trace.outputTokens.toLocaleString()} output`}
                >
                  {numeric(trace.inputTokens + trace.outputTokens)}
                </td>
              )}
              {columns.includes('costUsd') && (
                <td
                  className="obs-col-costUsd obs-number"
                  title={trace.costUsd == null ? 'Cost not recorded' : undefined}
                >
                  <span className={trace.costUsd == null ? 'obs-muted' : ''}>
                    {trace.costUsd == null ? '—' : money(trace.costUsd)}
                  </span>
                </td>
              )}
              {columns.includes('startTime') && (
                <td
                  className="obs-col-startTime obs-time"
                  title={new Date(trace.startTime).toLocaleString()}
                >
                  {date(trace.startTime)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="No matching traces"
      description="Change your filters or connect an application."
    />
  );
}

export function LogsPage() {
  const { projectId } = useWorkspace();
  return <TraceExplorer key={projectId} />;
}

function TraceExplorer() {
  const { projectId, refresh, refreshAll, notify, navigate } = useWorkspace();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<TraceSort>('startTime');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [columns, setColumns] = useState(defaultColumns);
  const [dense, setDense] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [poll, setPoll] = useState(0);
  const action = useAction();
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setPoll((value) => value + 1);
    }, 10000);
    return () => clearInterval(timer);
  }, [autoRefresh]);
  const { data, loading, error } = useData<{ items: Trace[]; total: number }>(
    `/traces?${qs({ projectId, search: query, status, limit: pageSize, offset, sort, direction })}`,
    refresh + poll,
  );
  useEffect(() => {
    if (data && !loading && offset > 0 && !data.items.length)
      setOffset(Math.max(0, Math.floor(Math.max(0, data.total - 1) / pageSize) * pageSize));
  }, [data, loading, offset, pageSize]);
  const traces = data?.items || [];
  const selectedIndex = traces.findIndex((trace) => trace.id === selected);
  function changeSort(next: TraceSort) {
    setDirection(
      next === sort ? (direction === 'asc' ? 'desc' : 'asc') : next === 'name' ? 'asc' : 'desc',
    );
    setSort(next);
    setOffset(0);
  }
  return (
    <div className="obs-page">
      <PageHeader
        title="Logs"
        actions={
          <>
            <Button onClick={() => navigate('integrations')}>
              <Code2 size={14} />
              Connect
            </Button>
            <Button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await download(`/traces/export?${qs({ projectId })}`, 'verus-traces.json');
                  notify('All project traces exported');
                })
              }
            >
              <ArrowDownToLine size={14} />
              Export
            </Button>
          </>
        }
      />
      <ErrorBox message={action.error || error} />
      <section className="obs-console" aria-label="Trace explorer">
        <div className="obs-toolbar">
          <div className="obs-search">
            <Search size={14} />
            <input
              aria-label="Search traces"
              placeholder="Search traces…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button
                className="icon-button"
                aria-label="Clear trace search"
                onClick={() => setSearch('')}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <select
            className="obs-status-select"
            aria-label="Filter trace status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            <option value="error">Errors</option>
            <option value="ok">Successful</option>
          </select>
          <div className="obs-sort-control">
            <select
              aria-label="Sort traces"
              value={sort}
              onChange={(event) => changeSort(event.target.value as TraceSort)}
            >
              {Object.entries(sortLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label={`Sort ${direction === 'asc' ? 'descending' : 'ascending'}`}
              title={`Sort ${direction === 'asc' ? 'descending' : 'ascending'}`}
              onClick={() => {
                setDirection(direction === 'asc' ? 'desc' : 'asc');
                setOffset(0);
              }}
            >
              <ArrowDownUp direction={direction} />
            </button>
          </div>
          <div className="obs-toolbar-actions">
            <button
              className="icon-button"
              aria-label="Clear trace filters"
              title="Clear filters"
              disabled={!search && !status}
              onClick={() => {
                setSearch('');
                setStatus('');
                setOffset(0);
              }}
            >
              <X size={14} />
            </button>
            <button
              className={`icon-button obs-refresh ${autoRefresh ? 'is-live' : ''}`}
              aria-label="Refresh traces"
              title={autoRefresh ? 'Auto-refreshing every 10 seconds' : 'Refresh traces'}
              disabled={loading}
              onClick={refreshAll}
            >
              <RefreshCw size={14} />
            </button>
            <details className="obs-column-menu">
              <summary>
                <Columns3 size={14} />
                View
                <ChevronDown size={12} />
              </summary>
              <div className="obs-view-menu">
                <strong>Columns</strong>
                {defaultColumns.map((column) => (
                  <label key={column}>
                    <input
                      type="checkbox"
                      checked={columns.includes(column)}
                      onChange={(event) =>
                        setColumns(
                          defaultColumns.filter((candidate) =>
                            candidate === column
                              ? event.target.checked
                              : columns.includes(candidate),
                          ),
                        )
                      }
                    />
                    {columnLabels[column]}
                  </label>
                ))}
                <div className="obs-menu-divider" />
                <label>
                  <input
                    type="checkbox"
                    checked={dense}
                    onChange={(event) => setDense(event.target.checked)}
                  />
                  Compact rows
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(event) => setAutoRefresh(event.target.checked)}
                  />
                  Refresh every 10s
                </label>
              </div>
            </details>
          </div>
        </div>
        <div className={`obs-workspace ${selected ? 'has-inspector' : ''}`}>
          <div className="obs-results" aria-busy={loading}>
            {loading && !data ? (
              <Loading />
            ) : (
              <TraceTable
                traces={traces}
                onSelect={setSelected}
                selectedId={selected}
                sort={sort}
                direction={direction}
                onSort={changeSort}
                columns={columns}
                dense={dense}
              />
            )}
            <div className="obs-pagination">
              <span>
                {data?.total
                  ? `${offset + 1}–${Math.min(offset + pageSize, data.total)} of ${data.total.toLocaleString()}`
                  : 'No results'}
              </span>
              <div>
                <select
                  aria-label="Traces per page"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setOffset(0);
                  }}
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
                <button
                  className="icon-button"
                  aria-label="Previous trace page"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Next trace page"
                  disabled={!data || offset + pageSize >= data.total || loading}
                  onClick={() => setOffset(offset + pageSize)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
          {selected && (
            <TraceInspector
              key={selected}
              id={selected}
              revision={poll}
              onClose={() => setSelected(null)}
              expandable
              onPrevious={
                selectedIndex > 0 ? () => setSelected(traces[selectedIndex - 1].id) : undefined
              }
              onNext={
                selectedIndex >= 0 && selectedIndex < traces.length - 1
                  ? () => setSelected(traces[selectedIndex + 1].id)
                  : undefined
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ArrowDownUp({ direction }: { direction: 'asc' | 'desc' }) {
  return direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
}

export function TraceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <Modal title="Trace inspector" description={id} onClose={onClose} wide>
      <div className="obs-focused">
        <TraceInspector key={id} id={id} />
      </div>
    </Modal>
  );
}

type DetailTab = 'io' | 'metadata' | 'review' | 'dataset';
function TraceInspector({
  id,
  onClose,
  expandable = false,
  onPrevious,
  onNext,
  revision = 0,
}: {
  id: string;
  onClose?: () => void;
  expandable?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  revision?: number;
}) {
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const inspectorId = useId();
  const { canWrite } = usePermissions();
  const [expanded, setExpanded] = useState(false);
  const detail = useData<TraceDetail>(`/traces/${encodeURIComponent(id)}`, refresh + revision);
  const datasets = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const [spanId, setSpanId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('io');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [spanSearch, setSpanSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [spanLimit, setSpanLimit] = useState(200);
  const [label, setLabel] = useState('correct');
  const [comment, setComment] = useState('');
  const [expected, setExpected] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [datasetExpected, setDatasetExpected] = useState('');
  const [datasetSource, setDatasetSource] = useState<'trace' | 'span'>('trace');
  const action = useAction();
  const trace = detail.data?.trace;
  const spans = detail.data?.spans || [];
  const span = spans.find((item) => item.id === spanId);
  const content = span || trace;
  const missingDatasetSpan = datasetSource === 'span' && !span;
  useEffect(() => {
    if (detail.data && missingDatasetSpan) setDatasetExpected('');
  }, [detail.data, missingDatasetSpan]);
  const hierarchy = useMemo(() => orderedSpans(spans), [detail.data]);
  const errorSpans = spans.filter((item) => item.status === 'error');
  const errorParents = new Set(errorSpans.map((item) => item.parentId));
  const firstFailure = errorSpans.find((item) => !errorParents.has(item.id)) || errorSpans[0];
  const visibleSpans = useMemo(() => {
    const searching = spanSearch.trim().toLowerCase();
    const hidden = new Set<string>();
    return hierarchy.filter((row) => {
      if (errorsOnly || searching)
        return (
          (!errorsOnly || row.span.status === 'error') &&
          (!searching ||
            `${row.span.name} ${row.span.kind} ${row.span.model || ''}`
              .toLowerCase()
              .includes(searching))
        );
      if (
        row.span.parentId &&
        (collapsed.has(row.span.parentId) || hidden.has(row.span.parentId))
      ) {
        hidden.add(row.span.id);
        return false;
      }
      return true;
    });
  }, [hierarchy, collapsed, errorsOnly, spanSearch]);
  const times = trace
    ? [Date.parse(trace.startTime), ...spans.map((item) => Date.parse(item.startTime))]
    : [0];
  const ends = trace
    ? [Date.parse(trace.endTime), ...spans.map((item) => Date.parse(item.endTime))]
    : [1];
  const begin = Math.min(...times),
    total = Math.max(1, Math.max(...ends) - begin);
  function chooseSpan(next: string | null) {
    if (next !== spanId && datasetSource === 'span') setDatasetExpected('');
    setSpanId(next);
    if (tab === 'dataset') setDatasetSource('trace');
  }
  async function copyValue(value: string, message: string) {
    await copy(value);
    notify(message);
  }
  const selectionDuration = content
    ? 'latencyMs' in content
      ? content.latencyMs
      : Math.max(0, Date.parse(content.endTime) - Date.parse(content.startTime))
    : 0;
  const view = (
    <aside className="obs-inspector" aria-label="Trace inspector">
      <div className="obs-inspector-top">
        <h2 title={trace?.name}>{trace?.name || 'Trace'}</h2>
        <div>
          {onClose && (
            <>
              <button
                className="icon-button"
                disabled={!onPrevious}
                aria-label="Inspect previous trace"
                onClick={onPrevious}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon-button"
                disabled={!onNext}
                aria-label="Inspect next trace"
                onClick={onNext}
              >
                <ChevronRight size={15} />
              </button>
              <span className="obs-filter-separator" />
            </>
          )}
          {expandable && (
            <button
              className="icon-button"
              aria-label="Expand trace inspector"
              onClick={() => setExpanded(true)}
            >
              <Expand size={14} />
            </button>
          )}
          {onClose && (
            <button className="icon-button" aria-label="Close trace inspector" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <ErrorBox message={detail.error || action.error} />
      {detail.loading && !trace ? (
        <Loading />
      ) : (
        trace && (
          <>
            <div className="obs-inspector-heading">
              <div>
                <button
                  className="obs-copy-id"
                  title="Copy full trace ID"
                  onClick={() => action.run(() => copyValue(id, 'Trace ID copied'))}
                >
                  <code>{id}</code>
                  <Copy size={11} />
                </button>
              </div>
              <Status value={trace.status} />
            </div>
            <div className="obs-trace-metrics">
              <Metric label="Duration" value={duration(trace.latencyMs)} />
              <Metric
                label="Tokens"
                value={numeric(trace.inputTokens + trace.outputTokens)}
                detail={`${trace.inputTokens.toLocaleString()} input · ${trace.outputTokens.toLocaleString()} output`}
              />
              <Metric
                label="Cost"
                value={trace.costUsd == null ? 'Not recorded' : money(trace.costUsd)}
              />
              <Metric label="Spans" value={String(spans.length)} />
            </div>
            {(trace.status === 'error' || errorSpans.length > 0) && (
              <div className="obs-failure-banner">
                <CircleAlert size={14} />
                <span>
                  {errorSpans.length
                    ? `${errorSpans.length} failed ${errorSpans.length === 1 ? 'span' : 'spans'}`
                    : 'Run failed'}
                </span>
                {errorSpans.length > 0 && (
                  <button
                    onClick={() => {
                      chooseSpan(firstFailure.id);
                      setTab('io');
                      setErrorsOnly(true);
                      setSpanSearch('');
                    }}
                  >
                    Inspect failure
                    <ChevronRight size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="obs-inspector-content">
              <div className="obs-trace-tree">
                <div className="obs-tree-heading">
                  <h3>
                    Spans<span>{spans.length}</span>
                  </h3>
                  <div className="obs-tree-search">
                    <Search size={12} />
                    <input
                      aria-label="Search spans"
                      placeholder="Find a span…"
                      value={spanSearch}
                      onChange={(event) => setSpanSearch(event.target.value)}
                    />
                    <button
                      className={`icon-button ${errorsOnly ? 'active' : ''}`}
                      aria-label="Show error spans only"
                      aria-pressed={errorsOnly}
                      title="Show error spans only"
                      onClick={() => setErrorsOnly(!errorsOnly)}
                    >
                      <CircleAlert size={13} />
                    </button>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={collapsed.size ? 'Expand all spans' : 'Collapse all spans'}
                    title={collapsed.size ? 'Expand all spans' : 'Collapse all spans'}
                    onClick={() =>
                      setCollapsed(
                        collapsed.size ? new Set() : new Set(spans.map((item) => item.id)),
                      )
                    }
                  >
                    {collapsed.size ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  </button>
                </div>
                <div className="obs-timeline-scale">
                  <span>{date(new Date(begin).toISOString())}</span>
                  <span>+{duration(total)}</span>
                </div>
                <div className="obs-span-list" role="group" aria-label="Span execution tree">
                  <button
                    className={`obs-root-row ${!span ? 'selected' : ''}`}
                    aria-pressed={!span}
                    onClick={() => chooseSpan(null)}
                  >
                    <Waypoints size={14} />
                    <span>Run summary</span>
                    <small>{duration(trace.latencyMs)}</small>
                  </button>
                  {visibleSpans.slice(0, spanLimit).map(({ span: item, depth, hasChildren }) => {
                    const start = Math.max(0, Date.parse(item.startTime) - begin),
                      elapsed = Math.max(0, Date.parse(item.endTime) - Date.parse(item.startTime));
                    const left = Math.min(99.5, (start / total) * 100),
                      width = Math.min(100 - left, Math.max(0.5, (elapsed / total) * 100));
                    return (
                      <div
                        key={item.id}
                        className={`obs-span-entry ${spanId === item.id ? 'selected' : ''} ${item.status}`}
                        style={{ '--depth': Math.min(depth, 8) } as CSSProperties}
                      >
                        <div className="obs-span-content">
                          {hasChildren && !errorsOnly && !spanSearch ? (
                            <button
                              className="obs-collapse-span"
                              aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} ${item.name}`}
                              aria-expanded={!collapsed.has(item.id)}
                              onClick={() =>
                                setCollapsed((previous) => {
                                  const next = new Set(previous);
                                  if (next.has(item.id)) next.delete(item.id);
                                  else next.add(item.id);
                                  return next;
                                })
                              }
                            >
                              {collapsed.has(item.id) ? (
                                <ChevronRight size={12} />
                              ) : (
                                <ChevronDown size={12} />
                              )}
                            </button>
                          ) : (
                            <span className="obs-collapse-spacer" />
                          )}
                          <button
                            className="obs-span-select"
                            aria-pressed={spanId === item.id}
                            title={`${item.name} · ${item.kind} · ${duration(elapsed)}`}
                            onClick={() => chooseSpan(item.id)}
                          >
                            <span className={`obs-span-kind ${item.kind}`}>
                              {item.status === 'error' ? (
                                <CircleAlert size={11} />
                              ) : item.kind === 'llm' ? (
                                <MessageSquare size={11} />
                              ) : item.kind === 'agent' ? (
                                <Waypoints size={11} />
                              ) : (
                                <Code2 size={11} />
                              )}
                            </span>
                            <span className="obs-span-title">
                              {item.name}
                              {item.model && <small>{item.model}</small>}
                            </span>
                            <span className="obs-span-duration">{duration(elapsed)}</span>
                          </button>
                        </div>
                        <div className="obs-span-waterfall">
                          <i style={{ left: `${left}%`, width: `${width}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  {visibleSpans.length > spanLimit && (
                    <div className="obs-more-spans">
                      <span>
                        {spanLimit} of {visibleSpans.length.toLocaleString()} matching spans
                      </span>
                      <button
                        className="obs-text-button"
                        onClick={() => setSpanLimit(spanLimit + 200)}
                      >
                        Show {Math.min(200, visibleSpans.length - spanLimit)} more
                      </button>
                    </div>
                  )}
                  {!visibleSpans.length && (
                    <div className="obs-tree-empty">
                      {spans.length
                        ? 'No spans match these filters.'
                        : 'Nested spans will appear here when your application records them.'}
                    </div>
                  )}
                </div>
              </div>
              <div className="obs-payload-pane">
                <div className="obs-selected-span">
                  <div>
                    <span className="obs-detail-eyebrow">
                      {span ? `${span.kind} span` : 'Root trace'}
                    </span>
                    <h3>{content?.name}</h3>
                  </div>
                  {span && <Status value={span.status} />}
                </div>
                <div className="obs-detail-tabs" role="tablist" aria-label="Trace detail views">
                  {[
                    { id: 'io', label: 'Input & output' },
                    { id: 'metadata', label: 'Metadata' },
                    { id: 'review', label: 'Review', count: detail.data?.annotations.length },
                    { id: 'dataset', label: 'Add to dataset' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      role="tab"
                      aria-selected={tab === item.id}
                      aria-controls={`${inspectorId}-${item.id}`}
                      id={`${inspectorId}-tab-${item.id}`}
                      className={tab === item.id ? 'active' : ''}
                      onClick={() => setTab(item.id as DetailTab)}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const tabs = Array.from(
                          event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          ),
                        );
                        const current = tabs.indexOf(event.currentTarget);
                        const next =
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                                tabs.length;
                        tabs[next].focus();
                        tabs[next].click();
                      }}
                    >
                      {item.id === 'dataset' && <Plus size={12} />}
                      {item.label}
                      {!!item.count && <span>{item.count}</span>}
                    </button>
                  ))}
                </div>
                <div
                  className="obs-payload-content"
                  role="tabpanel"
                  id={`${inspectorId}-${tab}`}
                  aria-labelledby={`${inspectorId}-tab-${tab}`}
                >
                  {tab === 'io' && content && (
                    <>
                      <div className="obs-selection-stats">
                        <span>{duration(selectionDuration)}</span>
                        {content.model && <span>{content.model}</span>}
                        <span>{numeric(content.inputTokens + content.outputTokens)} tokens</span>
                      </div>
                      <PayloadBlock
                        label="Input"
                        value={content.input}
                        onCopy={(value) => action.run(() => copyValue(value, 'Input copied'))}
                      />
                      <PayloadBlock
                        label="Output"
                        value={content.output}
                        onCopy={(value) => action.run(() => copyValue(value, 'Output copied'))}
                      />
                    </>
                  )}
                  {tab === 'metadata' && content && (
                    <>
                      <dl className="obs-metadata">
                        <dt>{span ? 'Span ID' : 'Trace ID'}</dt>
                        <dd>
                          <code>{content.id}</code>
                          <button
                            className="icon-button"
                            aria-label={`Copy ${span ? 'span' : 'trace'} ID`}
                            onClick={() => action.run(() => copyValue(content.id, 'ID copied'))}
                          >
                            <Copy size={12} />
                          </button>
                        </dd>
                        {span && (
                          <>
                            <dt>Parent span</dt>
                            <dd>
                              <code>{span.parentId || 'Root span'}</code>
                            </dd>
                          </>
                        )}
                        <dt>Started</dt>
                        <dd>{new Date(content.startTime).toLocaleString()}</dd>
                        <dt>Ended</dt>
                        <dd>{new Date(content.endTime).toLocaleString()}</dd>
                        <dt>Model</dt>
                        <dd>{content.model || 'Not recorded'}</dd>
                        <dt>Input / output</dt>
                        <dd>
                          {content.inputTokens.toLocaleString()} /{' '}
                          {content.outputTokens.toLocaleString()} tokens
                        </dd>
                        <dt>Cost</dt>
                        <dd>{money(content.costUsd)}</dd>
                        {!span && (
                          <>
                            <dt>Tags</dt>
                            <dd>
                              <div className="obs-tags">
                                {trace.tags.length
                                  ? trace.tags.map((tag) => <span key={tag}>{tag}</span>)
                                  : 'None'}
                              </div>
                            </dd>
                          </>
                        )}
                      </dl>
                      <PayloadBlock
                        label="Metadata"
                        value={content.metadata}
                        onCopy={(value) => action.run(() => copyValue(value, 'Metadata copied'))}
                      />
                    </>
                  )}
                  {tab === 'review' && (
                    <>
                      <div className="obs-action-intro">
                        <MessageSquare size={17} />
                        <div>
                          <h3>Review</h3>
                        </div>
                      </div>
                      <Form
                        onSubmit={() =>
                          action.run(async () => {
                            await post('/annotations', {
                              projectId,
                              targetType: 'trace',
                              targetId: id,
                              label,
                              comment,
                              ...(expected.trim()
                                ? { expected: parseJson(expected, 'Expected output') }
                                : {}),
                            });
                            setComment('');
                            setExpected('');
                            refreshAll();
                            notify('Review saved');
                          })
                        }
                      >
                        <Field label="Judgment">
                          <select value={label} onChange={(event) => setLabel(event.target.value)}>
                            <option value="correct">Correct</option>
                            <option value="incorrect">Incorrect</option>
                            <option value="needs_review">Needs review</option>
                          </select>
                        </Field>
                        <Field label="Comment">
                          <textarea
                            value={comment}
                            onChange={(event) => setComment(event.target.value)}
                            placeholder="What worked, what failed, or what should change?"
                          />
                        </Field>
                        <Field
                          label="Expected output · optional"
                          hint="Use valid JSON if you want to record the correct answer."
                        >
                          <textarea
                            className="code-input"
                            value={expected}
                            onChange={(event) => setExpected(event.target.value)}
                            placeholder='"The expected answer"'
                          />
                        </Field>
                        <FormActions busy={action.busy} label="Save review" />
                      </Form>
                      <div className="obs-review-history">
                        <h4>
                          Review history<span>{detail.data?.annotations.length || 0}</span>
                        </h4>
                        {detail.data?.annotations.length ? (
                          [...detail.data.annotations].reverse().map((annotation) => (
                            <article key={annotation.id}>
                              <div>
                                <Status value={annotation.label} />
                                <time title={new Date(annotation.createdAt).toLocaleString()}>
                                  {date(annotation.createdAt)}
                                </time>
                              </div>
                              <p>{annotation.comment || 'No comment added.'}</p>
                              {annotation.expected !== null && (
                                <PayloadBlock
                                  label="Expected output"
                                  value={annotation.expected}
                                  onCopy={(value) =>
                                    action.run(() => copyValue(value, 'Expected output copied'))
                                  }
                                />
                              )}
                            </article>
                          ))
                        ) : (
                          <p className="obs-muted">No reviews yet.</p>
                        )}
                      </div>
                    </>
                  )}
                  {tab === 'dataset' && (
                    <>
                      <div className="obs-action-intro">
                        <Database size={18} />
                        <div>
                          <h3>Save a test case</h3>
                        </div>
                      </div>
                      <ErrorBox message={datasets.error} />
                      <Form
                        onSubmit={() =>
                          action.run(async () => {
                            const source = resolveDatasetSource(datasetSource, trace, span);
                            await post(`/datasets/${encodeURIComponent(datasetId)}/rows`, {
                              rows: [
                                {
                                  input: source.input,
                                  expected: parseJson(datasetExpected, 'Expected output'),
                                  metadata: {
                                    sourceTraceId: trace.id,
                                    ...(datasetSource === 'span' && span
                                      ? { sourceSpanId: span.id }
                                      : {}),
                                  },
                                  tags: trace.tags,
                                },
                              ],
                            });
                            setDatasetExpected('');
                            refreshAll();
                            notify('Test case added to dataset');
                          })
                        }
                      >
                        <Field label="Input source">
                          <select
                            value={datasetSource}
                            onChange={(event) => {
                              setDatasetSource(event.target.value as 'trace' | 'span');
                              setDatasetExpected('');
                            }}
                          >
                            <option value="trace">Full trace · {trace.name}</option>
                            {span && <option value="span">Selected span · {span.name}</option>}
                            {missingDatasetSpan && (
                              <option value="span" disabled>
                                Selected span unavailable
                              </option>
                            )}
                          </select>
                        </Field>
                        {missingDatasetSpan ? (
                          <ErrorBox message="The selected span is no longer available. Choose an input source and review its expected output again." />
                        ) : (
                          <PayloadBlock
                            label="Input to save"
                            value={resolveDatasetSource(datasetSource, trace, span).input}
                            onCopy={(value) => action.run(() => copyValue(value, 'Input copied'))}
                          />
                        )}
                        <Field label="Destination dataset">
                          <select
                            required
                            value={datasetId}
                            onChange={(event) => setDatasetId(event.target.value)}
                          >
                            <option value="">Select a dataset</option>
                            {datasets.data?.map((dataset) => (
                              <option key={dataset.id} value={dataset.id}>
                                {dataset.name} · v{dataset.version}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {!datasets.loading && !datasets.data?.length && (
                          <p className="obs-muted">Create a dataset to save this input.</p>
                        )}
                        <Field
                          label="Expected output (JSON)"
                          hint="Use reviewed ground truth; the observed output is not copied."
                        >
                          <textarea
                            required
                            className="code-input"
                            value={datasetExpected}
                            onChange={(event) => setDatasetExpected(event.target.value)}
                            placeholder='"The correct answer"'
                          />
                        </Field>
                        <div className="form-actions">
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={
                              action.busy ||
                              !datasetId ||
                              !datasetExpected.trim() ||
                              !canWrite ||
                              missingDatasetSpan
                            }
                          >
                            <Plus size={14} />
                            {action.busy ? 'Saving…' : 'Add test case'}
                          </Button>
                        </div>
                      </Form>
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )
      )}
    </aside>
  );
  return expanded ? (
    <Modal title="Trace inspector" description={id} onClose={() => setExpanded(false)} wide>
      <div className="obs-focused">{view}</div>
    </Modal>
  ) : (
    view
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div title={detail}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PayloadBlock({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: Json;
  onCopy: (value: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  const structured = value !== null && typeof value === 'object';
  return (
    <section className="obs-payload-block">
      <header>
        <span>{label}</span>
        <div>
          {structured && (
            <button
              className={raw ? 'active' : ''}
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
              type="button"
            >
              <Code2 size={11} />
              JSON
            </button>
          )}
          <button
            type="button"
            aria-label={`Copy ${label.toLowerCase()}`}
            title={`Copy ${label.toLowerCase()}`}
            onClick={() =>
              onCopy(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
            }
          >
            <Copy size={12} />
          </button>
        </div>
      </header>
      {raw ? (
        <pre>{JSON.stringify(value, null, 2)}</pre>
      ) : structured ? (
        <div className="obs-json-tree">
          <JsonNode value={value} depth={0} />
        </div>
      ) : (
        <pre className={value === null ? 'obs-muted' : ''}>
          {value === null ? 'null' : String(value)}
        </pre>
      )}
    </section>
  );
}

function JsonNode({ value, name, depth }: { value: Json; name?: string; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [limit, setLimit] = useState(50);
  if (value === null || typeof value !== 'object')
    return (
      <div className="obs-json-leaf">
        {name !== undefined && <span className="obs-json-key">{name}: </span>}
        <span className={`obs-json-${value === null ? 'null' : typeof value}`}>
          {typeof value === 'string' ? JSON.stringify(value) : String(value)}
        </span>
      </div>
    );
  const entries = Object.entries(value),
    array = Array.isArray(value);
  return (
    <div className="obs-json-node">
      <button
        className="obs-json-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {name !== undefined && <span className="obs-json-key">{name}</span>}
        <span className="obs-json-type">
          {array ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
        {!expanded && <span className="obs-json-preview">{compact(value)?.slice(0, 100)}</span>}
      </button>
      {expanded && (
        <div className="obs-json-children">
          {entries.slice(0, limit).map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <button type="button" className="obs-text-button" onClick={() => setLimit(limit + 100)}>
              Show {Math.min(100, entries.length - limit)} more items
            </button>
          )}
          {!entries.length && (
            <span className="obs-muted">{array ? 'Empty array' : 'Empty object'}</span>
          )}
        </div>
      )}
    </div>
  );
}
