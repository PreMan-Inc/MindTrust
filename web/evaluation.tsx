import { useEffect, useState } from 'react';
import './evaluation-console.css';
import {
  averageScore,
  comparisonChange,
  filterDatasetRows,
  matchesEvaluationSearch,
  sortExperiments,
  type ComparisonChange,
  type ExperimentSort,
} from './evaluation-model';
import { usePermissions } from './session';
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  Eye,
  Filter,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpFromLine,
  ChevronRight,
  Database,
  FileJson,
  FlaskConical,
  GitCompareArrows,
  History,
  Pencil,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Comparison,
  ComparisonRow,
  Dataset,
  DatasetDetail,
  DatasetRow,
  EvalCase,
  Experiment,
  ExperimentDetail,
  Scorer,
  ServerInfo,
  TaskConfig,
} from '../shared/types';
import {
  api,
  compact,
  date,
  download,
  duration,
  money,
  parseJson,
  post,
  qs,
  useAction,
  useData,
  useWorkspace,
} from './lib';
import {
  Back,
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
  Status,
} from './ui';
import { Score, TraceDrawer } from './App';
export function DatasetsPage() {
  const { projectId, refresh } = useWorkspace();
  const { data, loading, error } = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('updated');
  if (selected) return <DatasetView id={selected} onBack={() => setSelected(null)} />;
  const filtered = data
    ?.filter((d) => matchesEvaluationSearch([d.name, d.description, d.id], search))
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'examples'
          ? b.rowCount - a.rowCount
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  return (
    <div className="eval-console">
      <PageHeader
        title="Datasets"
        actions={
          <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            Create dataset
          </Button>
        }
      />
      <ErrorBox message={error} />
      <div className="panel eval-table-panel">
        <div className="filter-bar">
          <div className="search-box">
            <Search size={16} />
            <input
              placeholder="Search datasets…"
              aria-label="Search datasets"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-spacer" />
          <select aria-label="Sort datasets" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Recently updated</option>
            <option value="name">Name A–Z</option>
            <option value="examples">Most examples</option>
          </select>
        </div>
        {loading && !data ? (
          <Loading />
        ) : filtered?.length ? (
          <div className="table-wrap">
            <table className="eval-datasets-table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Examples</th>
                  <th>Version</th>
                  <th>Last updated</th>
                  <th aria-label="Open dataset" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button className="row-title" onClick={() => setSelected(d.id)}>
                        <span className="eval-resource-icon">
                          <Database size={17} />
                        </span>
                        <span>
                          {d.name}
                          {d.description && <small>{d.description}</small>}
                        </span>
                      </button>
                    </td>
                    <td className="tabular">{d.rowCount.toLocaleString()}</td>
                    <td>
                      <Badge>v{d.version}</Badge>
                      {d.id === 'demo-dataset' && <Badge>Synthetic</Badge>}
                    </td>
                    <td className="muted nowrap">{date(d.updatedAt)}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open ${d.name}`}
                        onClick={() => setSelected(d.id)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={search ? 'No matching datasets' : 'No datasets yet'}
            description={
              search
                ? 'Try a different name or description.'
                : 'Create a dataset to add or import examples.'
            }
            action={
              search ? (
                <Button onClick={() => setSearch('')}>Clear search</Button>
              ) : (
                <Button permission="write" onClick={() => setCreate(true)}>
                  <Plus size={15} />
                  Create dataset
                </Button>
              )
            }
          />
        )}
        {!!filtered?.length && (
          <div className="eval-table-footer">
            {filtered.length} of {data?.length} datasets
          </div>
        )}
      </div>
      {create && (
        <CreateDataset
          onClose={() => setCreate(false)}
          onCreated={(d) => {
            setCreate(false);
            setSelected(d.id);
          }}
        />
      )}
    </div>
  );
}
function CreateDataset({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (d: Dataset) => void;
}) {
  const { projectId, refreshAll, notify } = useWorkspace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const action = useAction();
  return (
    <Modal title="Create dataset" onClose={onClose}>
      <Form
        onSubmit={() =>
          action.run(async () => {
            const d = await post<Dataset>('/datasets', { projectId, name, description });
            refreshAll();
            notify('Dataset created');
            onCreated(d);
          })
        }
      >
        <Field label="Dataset name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Support regression suite"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What behaviors should this dataset cover?"
          />
        </Field>
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Create dataset" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
function DatasetView({ id, onBack }: { id: string; onBack: () => void }) {
  const { canWrite } = usePermissions();
  const { refresh, refreshAll, notify } = useWorkspace();
  const [version, setVersion] = useState('');
  const [runningExperiment, setRunningExperiment] = useState(false);
  const [createdExperimentId, setCreatedExperimentId] = useState<string | null>(null);
  const detail = useData<DatasetDetail>(
    `/datasets/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`,
    refresh,
  );
  const [editing, setEditing] = useState<DatasetRow | 'new' | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<DatasetRow | null>(null);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [expectedFilter, setExpectedFilter] = useState<'all' | 'provided' | 'missing'>('all');
  const [history, setHistory] = useState(false);
  const [page, setPage] = useState(0);
  const action = useAction();
  const data = detail.data;
  const latest = data ? Math.max(...data.versions.map((v) => v.version)) : 0;
  const historical = !!version && !!data && Number(version) !== latest;
  const readOnly = historical || !canWrite || detail.loading;
  const filtered = filterDatasetRows(data?.rows ?? [], search, tag, expectedFilter);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const inspected = data?.rows.find((row) => row.id === inspecting);
  const tags = [...new Set(data?.rows.flatMap((row) => row.tags) ?? [])].sort();
  useEffect(() => {
    setPage(0);
  }, [search, tag, expectedFilter, version]);
  if (createdExperimentId)
    return (
      <ExperimentView
        id={createdExperimentId}
        onBack={() => setCreatedExperimentId(null)}
        backLabel="Back to dataset"
      />
    );
  return (
    <div className="eval-console">
      <Back onClick={onBack}>All datasets</Back>
      <PageHeader
        title={data?.dataset.name || 'Dataset'}
        description={data?.dataset.description}
        actions={
          <>
            <Button
              disabled={action.busy || detail.loading}
              onClick={() =>
                action.run(() =>
                  download(
                    `/datasets/${encodeURIComponent(id)}/export${version ? `?version=${version}` : ''}`,
                    `${data?.dataset.name || 'dataset'}.json`,
                  ),
                )
              }
            >
              <ArrowDownToLine size={15} />
              Export
            </Button>
            <Button disabled={readOnly} onClick={() => setImporting(true)}>
              <ArrowUpFromLine size={15} />
              Import JSON
            </Button>
            <Button
              disabled={readOnly || !data?.rows.length}
              onClick={() => setRunningExperiment(true)}
            >
              <FlaskConical size={15} />
              Run experiment
            </Button>
            <Button variant="primary" disabled={readOnly} onClick={() => setEditing('new')}>
              <Plus size={15} />
              Add example
            </Button>
          </>
        }
      />
      <ErrorBox message={detail.error || action.error} />
      {historical && (
        <div className="info-banner">
          <History size={16} />
          Viewing snapshot v{version}. Choose the latest version to edit examples.
        </div>
      )}
      <div className="eval-dataset-toolbar">
        <div className="eval-tabs">
          <button
            className={!history ? 'active' : ''}
            aria-pressed={!history}
            onClick={() => setHistory(false)}
          >
            <FileJson size={15} />
            Examples <span>{data?.rows.length ?? 0}</span>
          </button>
          <button
            className={history ? 'active' : ''}
            aria-pressed={history}
            onClick={() => setHistory(true)}
          >
            <History size={15} />
            Version history <span>{data?.versions.length ?? 0}</span>
          </button>
        </div>
        <select
          aria-label="Dataset version"
          value={version}
          disabled={detail.loading}
          onChange={(e) => {
            setVersion(e.target.value);
            setInspecting(null);
          }}
        >
          <option value="">Latest{latest ? ` · v${latest}` : ''}</option>
          {data?.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {date(v.createdAt)}
            </option>
          ))}
        </select>
      </div>
      {history ? (
        <div className="panel eval-history-panel">
          {detail.loading && !data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Examples</th>
                    <th>Created</th>
                    <th aria-label="Inspect version" />
                  </tr>
                </thead>
                <tbody>
                  {data?.versions.map((v) => (
                    <tr key={v.version}>
                      <td>
                        <Badge>v{v.version}</Badge>
                        {v.version === latest && <span className="eval-inline-label">Latest</span>}
                      </td>
                      <td>{v.rowCount.toLocaleString()}</td>
                      <td>{date(v.createdAt)}</td>
                      <td>
                        <Button
                          onClick={() => {
                            setVersion(v.version === latest ? '' : String(v.version));
                            setHistory(false);
                            setInspecting(null);
                          }}
                        >
                          Open version <ArrowRight size={13} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className={`eval-split ${inspected ? 'with-inspector' : ''}`}>
          <div className="panel eval-table-panel">
            <div className="filter-bar">
              <div className="search-box">
                <Search size={15} />
                <input
                  aria-label="Search dataset examples"
                  placeholder="Search examples…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                aria-label="Filter by tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
              >
                <option value="">All tags</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by expected output"
                value={expectedFilter}
                onChange={(e) => setExpectedFilter(e.target.value as typeof expectedFilter)}
              >
                <option value="all">Any ground truth</option>
                <option value="provided">Expected provided</option>
                <option value="missing">Expected missing</option>
              </select>
            </div>
            {detail.loading ? (
              <Loading />
            ) : visible.length ? (
              <div className="table-wrap">
                <table className="eval-example-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Input</th>
                      <th>Expected output</th>
                      <th>Tags</th>
                      <th aria-label="Inspect example" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row, i) => (
                      <tr key={row.id} className={inspecting === row.id ? 'eval-selected-row' : ''}>
                        <td className="eval-row-number">{currentPage * 50 + i + 1}</td>
                        <td>
                          <button className="cell-json" onClick={() => setInspecting(row.id)}>
                            {compact(row.input)}
                          </button>
                          <small className="row-id">{row.id}</small>
                        </td>
                        <td>
                          {row.hasExpected === false ? (
                            <span className="eval-missing">Not provided</span>
                          ) : (
                            <span className="cell-json">{compact(row.expected)}</span>
                          )}
                        </td>
                        <td>
                          <div className="tag-list">
                            {row.tags.map((t) => (
                              <button className="eval-tag" key={t} onClick={() => setTag(t)}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Inspect example ${row.id}`}
                            onClick={() => setInspecting(row.id)}
                          >
                            <Eye size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={data?.rows.length ? 'No matching examples' : 'No examples yet'}
                description={
                  data?.rows.length
                    ? 'Adjust the search or filters to see more examples.'
                    : 'Add an input and optional ground truth, or import a JSON dataset.'
                }
                action={
                  data?.rows.length ? (
                    <Button
                      onClick={() => {
                        setSearch('');
                        setTag('');
                        setExpectedFilter('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button disabled={readOnly} onClick={() => setEditing('new')}>
                      Add your first example
                    </Button>
                  )
                }
              />
            )}
            <EvalPagination
              page={currentPage}
              count={filtered.length}
              total={data?.rows.length}
              onPage={setPage}
            />
          </div>
          {inspected && (
            <aside className="eval-inspector" aria-label="Example details">
              <div className="eval-inspector-head">
                <h3>Example</h3>
                <button
                  className="icon-button"
                  aria-label="Close example details"
                  onClick={() => setInspecting(null)}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="eval-inspector-body">
                <code className="eval-record-id">{inspected.id}</code>
                <JsonBlock label="Input" value={inspected.input} />
                {inspected.hasExpected === false ? (
                  <div className="eval-no-ground-truth">
                    <span>Expected output</span>
                    <p>Not provided</p>
                  </div>
                ) : (
                  <JsonBlock label="Expected output" value={inspected.expected} />
                )}
                <JsonBlock label="Metadata" value={inspected.metadata} />
                <div className="tag-list">
                  {inspected.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              </div>
              <div className="eval-inspector-actions">
                <Button disabled={readOnly} onClick={() => setEditing(inspected)}>
                  <Pencil size={14} />
                  Edit example
                </Button>
                <Button variant="ghost" disabled={readOnly} onClick={() => setDeleting(inspected)}>
                  <Trash2 size={14} />
                  Remove
                </Button>
              </div>
            </aside>
          )}
        </div>
      )}
      {editing && (
        <DatasetRowEditor
          datasetId={id}
          row={editing === 'new' ? undefined : editing}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
        />
      )}
      {runningExperiment && (
        <CreateExperiment
          initialDatasetId={id}
          onClose={() => setRunningExperiment(false)}
          onCreated={(experiment) => {
            setRunningExperiment(false);
            setCreatedExperimentId(experiment.id);
          }}
        />
      )}
      {importing && <ImportRows id={id} onClose={() => setImporting(false)} />}
      {deleting && (
        <Modal
          title="Remove this example?"
          description="Earlier snapshots retain this example. Removal creates a new version."
          onClose={() => setDeleting(null)}
        >
          <JsonBlock label="Input" value={deleting.input} />
          <ErrorBox message={action.error} />
          <div className="form-actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              permission="write"
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await api(
                    `/datasets/${encodeURIComponent(id)}/rows/${encodeURIComponent(deleting.id)}`,
                    { method: 'DELETE' },
                  );
                  setDeleting(null);
                  setInspecting(null);
                  refreshAll();
                  notify('Example removed in a new dataset version');
                })
              }
            >
              Remove example
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EvalPagination({
  page,
  count,
  total,
  onPage,
}: {
  page: number;
  count: number;
  total?: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="eval-table-footer">
      <span>
        {count
          ? `${page * 50 + 1}–${Math.min((page + 1) * 50, count)} of ${count.toLocaleString()}`
          : '0 results'}
        {total !== undefined && count !== total ? ` · ${total.toLocaleString()} total` : ''}
      </span>
      <div>
        <Button
          variant="ghost"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          aria-label="Previous results page"
        >
          <ChevronLeft size={15} />
        </Button>
        <span>
          Page {page + 1} of {Math.max(1, Math.ceil(count / 50))}
        </span>
        <Button
          variant="ghost"
          disabled={(page + 1) * 50 >= count}
          onClick={() => onPage(page + 1)}
          aria-label="Next results page"
        >
          <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  );
}
function DatasetRowEditor({
  datasetId,
  row,
  readOnly,
  onClose,
}: {
  datasetId: string;
  row?: DatasetRow;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { refreshAll, notify } = useWorkspace();
  const [input, setInput] = useState(JSON.stringify(row ? row.input : { question: '' }, null, 2));
  const [hasExpected, setHasExpected] = useState(row ? row.hasExpected !== false : false);
  const [expected, setExpected] = useState(JSON.stringify(row ? row.expected : '', null, 2));
  const [metadata, setMetadata] = useState(JSON.stringify(row?.metadata ?? {}, null, 2));
  const [tags, setTags] = useState(row?.tags.join(', ') || '');
  const action = useAction();
  return (
    <Modal
      title={readOnly ? 'View example' : row ? 'Edit example' : 'Add an example'}
      description="Inputs and expected outputs are JSON values. Plain text must be quoted."
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            const meta = parseJson(metadata, 'Metadata');
            if (!meta || typeof meta !== 'object' || Array.isArray(meta))
              throw new Error('Metadata must be a JSON object.');
            await post(`/datasets/${encodeURIComponent(datasetId)}/rows`, {
              rows: [
                {
                  ...(row ? { id: row.id } : {}),
                  input: parseJson(input),
                  ...(hasExpected ? { expected: parseJson(expected, 'Expected output') } : {}),
                  metadata: meta,
                  tags: tags
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                },
              ],
            });
            refreshAll();
            notify('Example saved · dataset version created');
            onClose();
          })
        }
      >
        <div className="form-columns">
          <Field label="Input (JSON)">
            <textarea
              autoFocus
              className="code-input tall"
              readOnly={readOnly}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </Field>
          <div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={hasExpected}
                disabled={readOnly}
                onChange={(e) => setHasExpected(e.target.checked)}
              />
              <span>
                <strong>Include expected output</strong>
                <small>Leave unchecked when no ground truth is provided.</small>
              </span>
            </label>
            {hasExpected ? (
              <Field label="Expected output (JSON)" hint="JSON null is an explicit expected value.">
                <textarea
                  className="code-input tall"
                  readOnly={readOnly}
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </Field>
            ) : (
              <div className="json-block">
                <div className="json-label">Expected output</div>
                <pre className="muted">Not provided</pre>
              </div>
            )}
          </div>
        </div>
        <Field label="Tags" hint="Comma-separated labels">
          <input
            readOnly={readOnly}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="regression, edge-case"
          />
        </Field>
        <Field label="Metadata (JSON object)">
          <textarea
            className="code-input"
            readOnly={readOnly}
            value={metadata}
            onChange={(e) => setMetadata(e.target.value)}
          />
        </Field>
        <ErrorBox message={action.error} />
        {!readOnly && <FormActions busy={action.busy} label="Save example" onCancel={onClose} />}
      </Form>
    </Modal>
  );
}
function ImportRows({ id, onClose }: { id: string; onClose: () => void }) {
  const { refreshAll, notify } = useWorkspace();
  const [json, setJson] = useState('');
  const action = useAction();
  return (
    <Modal
      title="Import dataset examples"
      description="Accepts JSON arrays, including Braintrust exports. IDs are preserved and matching rows are updated."
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            const rows = parseJson(json, 'Import');
            if (!Array.isArray(rows)) throw new Error('Import a JSON array of examples.');
            await post(`/datasets/${encodeURIComponent(id)}/import`, { rows });
            refreshAll();
            notify(`${rows.length} examples imported`);
            onClose();
          })
        }
      >
        <Field label="Choose a JSON file">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                file
                  .text()
                  .then(setJson)
                  .catch((err) => action.setError(err.message));
            }}
          />
        </Field>
        <Field
          label="Or paste JSON"
          hint="Each row accepts input, expected, metadata, tags, and an optional id or _id."
        >
          <textarea
            className="code-input extra-tall"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={'[\n  {"input": "hello", "expected": "hello", "tags": ["smoke"]}\n]'}
          />
        </Field>
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Import examples" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
export function ExperimentsPage({
  linkedExperimentId,
  onLeaveLinkedExperiment,
}: { linkedExperimentId?: string; onLeaveLinkedExperiment?: () => void } = {}) {
  const { projectId, refresh } = useWorkspace();
  const list = useData<Experiment[]>(`/experiments?${qs({ projectId })}`, refresh);
  const datasets = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const [scoreMetric, setScoreMetric] = useState('');
  const [selected, setSelected] = useState<string | null>(linkedExperimentId || null);
  const [create, setCreate] = useState(false);
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [dataset, setDataset] = useState('');
  const [sort, setSort] = useState<ExperimentSort>('created');
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (linkedExperimentId) setSelected(linkedExperimentId);
  }, [linkedExperimentId]);
  useEffect(() => {
    setPage(0);
  }, [search, status, dataset, sort, ascending, scoreMetric]);
  useEffect(() => {
    if (list.data?.some((e) => ['running', 'queued'].includes(e.status))) {
      const timer = setInterval(list.reload, 1500);
      return () => clearInterval(timer);
    }
  }, [list.data, list.reload]);
  if (selected)
    return (
      <ExperimentView
        id={selected}
        onBack={() => {
          setSelected(null);
          onLeaveLinkedExperiment?.();
        }}
      />
    );
  if (comparing && baseline && candidate)
    return (
      <CompareView baseline={baseline} candidate={candidate} onBack={() => setComparing(false)} />
    );
  const filtered = sortExperiments(
    (list.data ?? []).filter(
      (e) =>
        matchesEvaluationSearch([e.name, e.description, e.task, e.executionSource], search) &&
        (!status || status === e.status) &&
        (!dataset || dataset === e.datasetId),
    ),
    sort,
    ascending,
    scoreMetric,
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  function selectForCompare(id: string) {
    setCompareOpen(true);
    if (baseline === id) setBaseline('');
    else if (candidate === id) setCandidate('');
    else if (!baseline) setBaseline(id);
    else setCandidate(id);
  }
  function sortColumn(label: string, field: ExperimentSort) {
    return (
      <th aria-sort={sort === field ? (ascending ? 'ascending' : 'descending') : 'none'}>
        <button
          className="eval-sort-button"
          onClick={() => {
            setSort(field);
            setAscending(
              sort === field
                ? !ascending
                : field === 'name' || field === 'latency' || field === 'cost',
            );
          }}
        >
          {label}
          {sort === field ? (
            ascending ? (
              <ArrowUp size={12} />
            ) : (
              <ArrowDown size={12} />
            )
          ) : (
            <ArrowUpDown size={12} />
          )}
        </button>
      </th>
    );
  }
  return (
    <div className="eval-console">
      <PageHeader
        title="Experiments"
        actions={
          <>
            <Button
              aria-expanded={compareOpen}
              aria-controls="experiment-comparison-picker"
              onClick={() => setCompareOpen((open) => !open)}
            >
              <GitCompareArrows size={15} />
              Compare
            </Button>
            <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
              <Plus size={16} />
              New experiment
            </Button>
          </>
        }
      />
      <ErrorBox message={list.error || datasets.error || scorers.error} />
      <div className="panel eval-table-panel">
        {compareOpen && (
          <div className="eval-comparison-picker" id="experiment-comparison-picker">
            <label>
              <span>Baseline</span>
              <select
                aria-label="Baseline experiment"
                value={baseline}
                onChange={(ev) => {
                  setBaseline(ev.target.value);
                  if (ev.target.value === candidate) setCandidate('');
                }}
              >
                <option value="">Select run…</option>
                {list.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              aria-label="Swap selected experiments"
              disabled={!baseline || !candidate}
              onClick={() => {
                setBaseline(candidate);
                setCandidate(baseline);
              }}
            >
              <ArrowLeftRight size={16} />
            </button>
            <label>
              <span>Candidate</span>
              <select
                aria-label="Candidate experiment"
                value={candidate}
                onChange={(ev) => setCandidate(ev.target.value)}
              >
                <option value="">Select run…</option>
                {list.data
                  ?.filter((e) => e.id !== baseline)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              disabled={!baseline || !candidate || baseline === candidate}
              onClick={() => setComparing(true)}
            >
              Open comparison
              <ArrowRight size={14} />
            </Button>
            <button
              className="icon-button"
              aria-label="Close and clear comparison selection"
              onClick={() => {
                setBaseline('');
                setCandidate('');
                setCompareOpen(false);
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="filter-bar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="Search experiments"
              placeholder="Search experiments or models…"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
            />
          </div>
          <select
            aria-label="Filter experiment status"
            value={status}
            onChange={(ev) => setStatus(ev.target.value)}
          >
            <option value="">All statuses</option>
            {['completed', 'running', 'queued', 'failed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter experiment dataset"
            value={dataset}
            onChange={(ev) => setDataset(ev.target.value)}
          >
            <option value="">All datasets</option>
            {datasets.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Experiment score metric"
            value={scoreMetric}
            onChange={(event) => setScoreMetric(event.target.value)}
          >
            <option value="">Mean of all scores</option>
            {[...new Set(list.data?.flatMap((e) => Object.keys(e.scores)) ?? [])].map((id) => (
              <option key={id} value={id}>
                {scorers.data?.find((s) => s.id === id)?.name || id}
              </option>
            ))}
          </select>
        </div>
        {list.loading && !list.data ? (
          <Loading />
        ) : visible.length ? (
          <div className="table-wrap">
            <table className="eval-experiments-table">
              <thead>
                <tr>
                  <th className="checkbox-col" aria-label="Select for comparison" />
                  {sortColumn('Experiment', 'name')}
                  <th>Status</th>
                  <th>Cases</th>
                  {sortColumn(
                    scoreMetric
                      ? scorers.data?.find((s) => s.id === scoreMetric)?.name || scoreMetric
                      : 'Mean score',
                    'score',
                  )}
                  {sortColumn('Latency', 'latency')}
                  {sortColumn('Cost', 'cost')}
                  {sortColumn('Created', 'created')}
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr
                    key={e.id}
                    className={baseline === e.id || candidate === e.id ? 'eval-selected-row' : ''}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={baseline === e.id || candidate === e.id}
                        onChange={() => selectForCompare(e.id)}
                        aria-label={`Compare ${e.name}`}
                      />
                    </td>
                    <td>
                      <button className="row-title" onClick={() => setSelected(e.id)}>
                        <span className="eval-resource-icon">
                          <FlaskConical size={16} />
                        </span>
                        <span>
                          {e.name}
                          <small>
                            {datasets.data?.find((d) => d.id === e.datasetId)?.name || e.datasetId}{' '}
                            · v{e.datasetVersion} ·{' '}
                            {e.executionSource === 'sdk-import'
                              ? 'SDK'
                              : e.executionSource === 'synthetic'
                                ? 'Synthetic'
                                : e.task.type === 'openai'
                                  ? e.task.model
                                  : e.task.type}
                          </small>
                        </span>
                      </button>
                      {(baseline === e.id || candidate === e.id) && (
                        <span className="eval-selection-label">
                          {baseline === e.id ? 'Baseline' : 'Candidate'}
                        </span>
                      )}
                    </td>
                    <td>
                      <Status value={e.status} />
                    </td>
                    <td className="tabular">
                      {e.completedCases}/{e.totalCases}
                    </td>
                    <td>
                      <Score value={scoreMetric ? e.scores[scoreMetric] : averageScore(e.scores)} />
                      {!scoreMetric && (
                        <small className="eval-metric-note">
                          {e.scorerIds.length} {e.scorerIds.length === 1 ? 'scorer' : 'scorers'}
                        </small>
                      )}
                    </td>
                    <td className="tabular">{duration(e.latencyMs)}</td>
                    <td className="tabular">
                      {money(e.costUsd)}
                      {e.unknownCostCount > 0 && (
                        <small className="eval-metric-note">{e.unknownCostCount} unknown</small>
                      )}
                    </td>
                    <td className="muted nowrap">{date(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={list.data?.length ? 'No matching experiments' : 'Start with a baseline'}
            description={
              list.data?.length
                ? 'Try a different search, status, or dataset.'
                : 'Run an evaluation against a dataset, then compare your next change.'
            }
            action={
              list.data?.length ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setStatus('');
                    setDataset('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button permission="write" onClick={() => setCreate(true)}>
                  Create an experiment
                </Button>
              )
            }
          />
        )}
        <EvalPagination
          page={currentPage}
          count={filtered.length}
          total={list.data?.length}
          onPage={setPage}
        />
      </div>
      {create && (
        <CreateExperiment
          onClose={() => setCreate(false)}
          onCreated={(e) => {
            setCreate(false);
            setSelected(e.id);
          }}
        />
      )}
    </div>
  );
}
function CreateExperiment({
  onClose,
  onCreated,
  initialDatasetId = '',
}: {
  onClose: () => void;
  onCreated: (e: Experiment) => void;
  initialDatasetId?: string;
}) {
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const datasets = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const info = useData<ServerInfo>('/info');
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState(initialDatasetId);
  const [ids, setIds] = useState<string[]>([]);
  const [type, setType] = useState<TaskConfig['type']>('template');
  const [template, setTemplate] = useState('{{input}}');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [trials, setTrials] = useState(1);
  const [concurrency, setConcurrency] = useState(4);
  const action = useAction();
  return (
    <Modal
      title="New experiment"
      description="Run a reproducible evaluation against a snapshot of your dataset."
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            if (!datasetId) throw new Error('Choose a dataset.');
            if (!ids.length) throw new Error('Choose at least one scorer.');
            const task: TaskConfig =
              type === 'echo'
                ? { type }
                : type === 'template'
                  ? { type, template }
                  : { type, template, system, model, temperature: 0 };
            const experiment = await post<Experiment>('/experiments', {
              projectId,
              name,
              datasetId,
              scorerIds: ids,
              task,
              trials,
              concurrency,
            });
            refreshAll();
            notify('Experiment started');
            onCreated(experiment);
          })
        }
      >
        <Field label="Experiment name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Support agent · prompt v2"
          />
        </Field>
        <Field
          label="Dataset"
          hint="The latest version will be pinned when this experiment starts."
        >
          <select required value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
            <option value="">Choose a dataset</option>
            {datasets.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · v{d.version} · {d.rowCount} examples
              </option>
            ))}
          </select>
        </Field>
        <Field label="Task execution">
          <select value={type} onChange={(e) => setType(e.target.value as TaskConfig['type'])}>
            <option value="template">Template rendering · local, no model call</option>
            <option value="echo">Echo input · local, no model call</option>
            <option value="openai" disabled={!info.data?.providerConfigured}>
              Configured model provider{!info.data?.providerConfigured ? ' · not configured' : ''}
            </option>
          </select>
        </Field>
        {type !== 'echo' && (
          <Field
            label={type === 'openai' ? 'User prompt template' : 'Template'}
            hint="Use {{input}} for the full input, or {{input.field}} for a field."
          >
            <textarea
              className="code-input"
              required
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </Field>
        )}
        {type === 'openai' && (
          <>
            <div className="info-banner">
              This run uses your server’s provider credentials and may incur model charges.
            </div>
            <Field label="Model">
              <input required value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field label="System prompt">
              <textarea value={system} onChange={(e) => setSystem(e.target.value)} />
            </Field>
          </>
        )}
        <fieldset className="scorer-picker">
          <legend>Scorers</legend>
          {scorers.loading ? (
            <Loading />
          ) : (
            scorers.data?.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(s.id)}
                  onChange={() =>
                    setIds((v) => (v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id]))
                  }
                />
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.description || s.type}</small>
                </span>
              </label>
            ))
          )}
          {!scorers.data?.length && !scorers.loading && (
            <span className="muted">Create a scorer before running an experiment.</span>
          )}
        </fieldset>
        <div className="form-columns">
          <Field label="Trials per example" hint="Repeat each example 1–10 times.">
            <input
              type="number"
              min="1"
              max="10"
              value={trials}
              onChange={(e) => setTrials(Number(e.target.value))}
            />
          </Field>
          <Field label="Concurrency" hint="Run 1–16 cases at the same time.">
            <input
              type="number"
              min="1"
              max="16"
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
            />
          </Field>
        </div>
        <ErrorBox message={action.error || datasets.error || scorers.error} />
        <FormActions busy={action.busy} label="Run experiment" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
function ExperimentView({
  id,
  onBack,
  backLabel = 'All experiments',
}: {
  id: string;
  onBack: () => void;
  backLabel?: string;
}) {
  const { refresh, refreshAll, notify } = useWorkspace();
  const detail = useData<ExperimentDetail>(`/experiments/${encodeURIComponent(id)}`, refresh);
  const [selected, setSelected] = useState<EvalCase | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [filter, search]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const action = useAction();
  const e = detail.data?.experiment;
  const running = e && ['queued', 'running'].includes(e.status);
  const columns =
    e?.scorerIds.map(
      (id) =>
        detail.data?.scorers.find((s) => s.id === id) || { id, name: id, type: 'external scorer' },
    ) || [];
  useEffect(() => {
    if (running) {
      const timer = setInterval(detail.reload, 1200);
      return () => clearInterval(timer);
    }
  }, [running, detail.reload]);
  const filtered = (detail.data?.cases ?? []).filter(
    (c) =>
      matchesEvaluationSearch([c.input, c.output, c.expected, c.error, c.rowId], search) &&
      (filter === 'all' || filter === 'errors'
        ? filter === 'all' || !!c.error
        : filter === 'score-errors'
          ? Object.keys(c.scoreErrors).length > 0
          : Object.values(c.scores).some((v) => v != null && v < 1)),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const rows = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  return (
    <div className="eval-console">
      <Back onClick={onBack}>{backLabel}</Back>
      <PageHeader
        title={e?.name || 'Experiment'}
        description={
          e
            ? `Dataset v${e.datasetVersion} · ${e.trials} ${e.trials === 1 ? 'trial' : 'trials'} per example · ${e.executionSource === 'sdk-import' ? 'SDK import' : e.executionSource === 'synthetic' ? 'Synthetic fixture' : e.task.type === 'openai' ? e.task.model : e.task.type + ' execution'} · ${date(e.createdAt)}`
            : undefined
        }
        actions={
          <>
            {running && (
              <Button
                permission="write"
                variant="danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await post(`/experiments/${encodeURIComponent(id)}/cancel`, {});
                    refreshAll();
                    notify('Cancellation requested');
                  })
                }
              >
                <Square size={13} />
                Cancel run
              </Button>
            )}
            <Button
              onClick={() =>
                action.run(() =>
                  download(
                    `/experiments/${encodeURIComponent(id)}/export`,
                    'mindtrust-experiment.json',
                  ),
                )
              }
            >
              <ArrowDownToLine size={15} />
              Export
            </Button>
          </>
        }
      />
      <ErrorBox message={detail.error || action.error || e?.error || ''} />
      {detail.loading && !e ? (
        <Loading />
      ) : (
        e && (
          <>
            <div className="panel eval-experiment-summary">
              <div className="experiment-state">
                <Status value={e.status} />
                {running && (
                  <div className="progress-track">
                    <i
                      style={{
                        width: `${e.totalCases ? (e.completedCases / e.totalCases) * 100 : 0}%`,
                      }}
                    />
                  </div>
                )}
                <span>
                  {e.completedCases} / {e.totalCases} cases
                </span>
              </div>
              <dl className="eval-run-summary">
                {columns.map((s) => (
                  <div key={s.id}>
                    <dt title={s.type.replaceAll('_', ' ')}>{s.name}</dt>
                    <dd>
                      <Score value={e.scores[s.id]} />
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Mean latency</dt>
                  <dd>{duration(e.latencyMs)}</dd>
                </div>
                <div>
                  <dt>Recorded cost</dt>
                  <dd>
                    {money(e.costUsd)}
                    {!!e.unknownCostCount && <small>{e.unknownCostCount} unknown</small>}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="panel eval-table-panel">
              <div className="filter-bar">
                <div className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Search evaluation cases"
                    placeholder="Search inputs, outputs, or errors…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <span className="count-label">{filtered.length} results</span>
                <div className="filter-spacer" />
                <select
                  value={filter}
                  aria-label="Filter cases"
                  onChange={(ev) => setFilter(ev.target.value)}
                >
                  <option value="all">All cases</option>
                  <option value="failures">Scores below 100%</option>
                  <option value="errors">Execution errors</option>
                  <option value="score-errors">Scorer errors</option>
                </select>
              </div>
              {rows?.length ? (
                <div className="table-wrap">
                  <table className="cases-table">
                    <thead>
                      <tr>
                        <th>Input</th>
                        <th>Output</th>
                        {columns.map((s) => (
                          <th key={s.id}>{s.name}</th>
                        ))}
                        <th>Latency</th>
                        <th>Trial</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <button className="cell-json" onClick={() => setSelected(c)}>
                              {compact(c.input)}
                            </button>
                          </td>
                          <td>
                            <span className={`cell-json ${c.error ? 'error-text' : ''}`}>
                              {c.error || compact(c.output)}
                            </span>
                          </td>
                          {columns.map((s) => (
                            <td key={s.id}>
                              <Score value={c.scores[s.id]} />
                              {c.scoreErrors[s.id] && (
                                <small className="error-text block">Score error</small>
                              )}
                            </td>
                          ))}
                          <td className="tabular">{duration(c.latencyMs)}</td>
                          <td>{c.trial}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={running ? 'Evaluation in progress' : 'No matching cases'}
                  description={
                    running
                      ? 'Results will appear here as each case completes.'
                      : 'Change the filter to see more results.'
                  }
                />
              )}
              <EvalPagination
                page={currentPage}
                count={filtered.length}
                total={detail.data?.cases.length}
                onPage={setPage}
              />
            </div>
          </>
        )
      )}
      {selected && (
        <CaseDrawer
          row={selected}
          onClose={() => setSelected(null)}
          onTrace={(id) => {
            setSelected(null);
            setTraceId(id);
          }}
        />
      )}{' '}
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}
    </div>
  );
}
function CaseDrawer({
  row,
  onClose,
  onTrace,
}: {
  row: EvalCase;
  onClose: () => void;
  onTrace: (id: string) => void;
}) {
  const { projectId, refreshAll, notify } = useWorkspace();
  const [label, setLabel] = useState('needs_review');
  const [comment, setComment] = useState('');
  const action = useAction();
  return (
    <Modal
      title="Evaluation case"
      description={`${row.rowId} · Trial ${row.trial}`}
      onClose={onClose}
      drawer
    >
      <div className="trace-summary">
        <span>{duration(row.latencyMs)}</span>
        <span>{money(row.costUsd)}</span>
        {row.traceId && (
          <Button onClick={() => onTrace(row.traceId!)}>
            Open trace
            <ArrowRight size={14} />
          </Button>
        )}
      </div>
      <ErrorBox message={row.error || ''} />
      <JsonBlock label="Input" value={row.input} />
      <JsonBlock label="Expected" value={row.expected} />
      <JsonBlock label="Output" value={row.output} />
      <JsonBlock label="Scores" value={row.scores} />
      {Object.keys(row.scoreErrors).length > 0 && (
        <JsonBlock label="Scorer errors" value={row.scoreErrors} />
      )}
      <Form
        onSubmit={() =>
          action.run(async () => {
            await post('/annotations', {
              projectId,
              targetType: 'case',
              targetId: row.id,
              label,
              comment,
              expected: row.expected,
            });
            refreshAll();
            notify('Case review saved');
            onClose();
          })
        }
      >
        <Field label="Review">
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="needs_review">Needs review</option>
            <option value="correct">Correct</option>
            <option value="incorrect">Incorrect</option>
          </select>
        </Field>
        <Field label="Comment">
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Save review" />
      </Form>
    </Modal>
  );
}
function CompareView({
  baseline,
  candidate,
  onBack,
}: {
  baseline: string;
  candidate: string;
  onBack: () => void;
}) {
  const { refresh, projectId } = useWorkspace();
  const [swapped, setSwapped] = useState(false);
  const result = useData<Comparison>(
    `/compare?${qs({ baseline: swapped ? candidate : baseline, candidate: swapped ? baseline : candidate })}`,
    refresh,
  );
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const [selected, setSelected] = useState<ComparisonRow | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ComparisonChange | 'all'>('all');
  const [metric, setMetric] = useState('');
  const [page, setPage] = useState(0);
  const [traceId, setTraceId] = useState<string | null>(null);
  const data = result.data;
  const scoreName = (id: string) => scorers.data?.find((scorer) => scorer.id === id)?.name || id;
  const counts = { regressed: 0, improved: 0, mixed: 0, unchanged: 0, unscored: 0, unmatched: 0 };
  for (const row of data?.rows ?? []) counts[comparisonChange(row, metric)]++;
  const filtered = (data?.rows ?? []).filter(
    (row) =>
      (filter === 'all' || comparisonChange(row, metric) === filter) &&
      matchesEvaluationSearch(
        [
          row.rowId,
          row.input,
          row.baseline?.input,
          row.candidate?.input,
          row.baseline?.output,
          row.candidate?.output,
          row.baseline?.error,
          row.candidate?.error,
        ],
        search,
      ),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const scoreIds = metric ? [metric] : Object.keys(data?.deltas ?? {});
  useEffect(() => {
    setPage(0);
  }, [search, filter, metric, swapped]);
  const filterNames: Record<ComparisonChange | 'all', string> = {
    all: 'All cases',
    regressed: 'Regressions',
    improved: 'Improvements',
    mixed: 'Mixed changes',
    unchanged: 'Unchanged',
    unscored: 'No paired score',
    unmatched: 'Unmatched',
  };
  return (
    <div className="eval-console">
      <Back onClick={onBack}>All experiments</Back>
      <PageHeader
        title="Compare experiments"
        actions={
          <Button
            onClick={() => {
              setSwapped((value) => !value);
              setSelected(null);
            }}
          >
            <ArrowLeftRight size={15} />
            Swap baseline
          </Button>
        }
      />
      <ErrorBox message={result.error || scorers.error} />
      {result.loading ? (
        <Loading />
      ) : (
        data && (
          <>
            {data.warning && (
              <div className="warning-banner eval-provenance-warning">
                <Filter size={16} />
                <div>
                  <strong>Check comparison coverage</strong>
                  <p>{data.warning}</p>
                </div>
              </div>
            )}
            <div className="panel eval-comparison-summary">
              <div className="eval-run-pair">
                {[data.baseline, data.candidate].map((experiment, i) => (
                  <div className="eval-run-card" key={experiment.id}>
                    <div className="eval-run-card-heading">
                      <span className="eval-run-role">{i ? 'Candidate' : 'Baseline'}</span>
                      <Status value={experiment.status} />
                    </div>
                    <h2>{experiment.name}</h2>
                    <div className="eval-run-provenance">
                      <Database size={13} />
                      <code>{experiment.datasetId}</code>
                      <Badge>v{experiment.datasetVersion}</Badge>
                      <span>
                        {experiment.executionSource === 'sdk-import'
                          ? 'SDK import'
                          : experiment.executionSource === 'synthetic'
                            ? 'Synthetic'
                            : 'Server run'}
                      </span>
                    </div>
                    <div className="eval-run-metrics">
                      <span>
                        <strong>{experiment.completedCases.toLocaleString()}</strong> cases
                      </span>
                      <span>
                        <strong>{duration(experiment.latencyMs)}</strong> mean latency
                      </span>
                      <span>
                        <strong>{money(experiment.costUsd)}</strong> recorded cost
                        {experiment.unknownCostCount
                          ? ` · ${experiment.unknownCostCount} unknown`
                          : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="eval-coverage-strip">
                <span>
                  <span
                    className={`status-dot ${data.comparable ? 'eval-positive' : 'eval-warning'}`}
                  />
                  <strong>
                    {data.rows.length - counts.unmatched} / {data.rows.length}
                  </strong>{' '}
                  paired cases
                </span>
                <span>
                  {data.comparable
                    ? 'Same revision · matched by row and trial'
                    : 'Unaligned comparison · aggregate changes withheld'}
                </span>
              </div>
              {!!Object.keys(data.deltas).length && (
                <div className="table-wrap eval-score-summary">
                  <table aria-label="Mean score comparison">
                    <thead>
                      <tr>
                        <th>Score</th>
                        <th>Baseline</th>
                        <th>Candidate</th>
                        <th title="Candidate minus baseline">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(data.deltas).map(([id, delta]) => (
                        <tr key={id} className={metric === id ? 'eval-selected-row' : ''}>
                          <td>
                            <button
                              className="eval-score-filter"
                              onClick={() => setMetric(metric === id ? '' : id)}
                              aria-pressed={metric === id}
                              title={`Filter cases by ${scoreName(id)}`}
                            >
                              {scoreName(id)}
                              {metric === id && <span>Selected</span>}
                            </button>
                          </td>
                          <td>
                            <Score value={data.baseline.scores[id]} />
                          </td>
                          <td>
                            <Score value={data.candidate.scores[id]} />
                          </td>
                          <td>
                            <Score value={delta} delta />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="panel eval-table-panel">
              <div className="filter-bar">
                <div className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Search comparison cases"
                    placeholder="Search cases…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <select
                  aria-label="Comparison score"
                  value={metric}
                  onChange={(event) => setMetric(event.target.value)}
                >
                  <option value="">All scores</option>
                  {Object.keys(data.deltas).map((id) => (
                    <option key={id} value={id}>
                      {scoreName(id)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="eval-result-filters" aria-label="Comparison result filters">
                {(
                  [
                    'all',
                    'regressed',
                    'improved',
                    'mixed',
                    'unchanged',
                    'unscored',
                    'unmatched',
                  ] as const
                ).map((value) => (
                  <button
                    key={value}
                    className={filter === value ? 'active' : ''}
                    onClick={() => setFilter(value)}
                    aria-pressed={filter === value}
                  >
                    <span className={`eval-change-dot ${value}`} />
                    {filterNames[value]}
                    <strong>{value === 'all' ? data.rows.length : counts[value]}</strong>
                  </button>
                ))}
              </div>
              {visible.length ? (
                <div className="table-wrap">
                  <table className="eval-comparison-table">
                    <thead>
                      <tr>
                        <th>Change</th>
                        <th>Input</th>
                        <th>Baseline output</th>
                        <th>Candidate output</th>
                        {scoreIds.map((id) => (
                          <th key={id}>Δ {scoreName(id)}</th>
                        ))}
                        <th aria-label="Open comparison" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => (
                        <tr key={`${row.rowId}:${row.trial}`}>
                          <td>
                            <span className={`eval-change-label ${comparisonChange(row, metric)}`}>
                              {filterNames[comparisonChange(row, metric)]}
                            </span>
                          </td>
                          <td>
                            <button className="cell-json" onClick={() => setSelected(row)}>
                              {compact(row.input)}
                            </button>
                            <small className="row-id">
                              Trial {row.trial} · {row.rowId}
                            </small>
                          </td>
                          <td>
                            <span
                              className={`cell-json ${row.baseline?.error ? 'error-text' : ''}`}
                            >
                              {row.baseline
                                ? row.baseline.error || compact(row.baseline.output)
                                : 'Unmatched'}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`cell-json ${row.candidate?.error ? 'error-text' : ''}`}
                            >
                              {row.candidate
                                ? row.candidate.error || compact(row.candidate.output)
                                : 'Unmatched'}
                            </span>
                          </td>
                          {scoreIds.map((id) => (
                            <td key={id}>
                              <Score value={row.deltas[id]} delta />
                            </td>
                          ))}
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`Compare outputs for ${row.rowId}, trial ${row.trial}`}
                              onClick={() => setSelected(row)}
                            >
                              <Eye size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="No cases match these filters"
                  description="Choose another score or result category to continue your review."
                  action={
                    <Button
                      onClick={() => {
                        setFilter('all');
                        setSearch('');
                        setMetric('');
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              )}
              <EvalPagination
                page={currentPage}
                count={filtered.length}
                total={data.rows.length}
                onPage={setPage}
              />
            </div>
            <p className="eval-footnote">
              Changes are candidate − baseline. Mixed means scores moved in both directions.
              Unpaired scores are excluded from improvements and regressions.
            </p>
          </>
        )
      )}
      {selected && data && (
        <Modal
          title="Compare outputs"
          description={`Row ${selected.rowId} · trial ${selected.trial}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="eval-output-comparison">
            {[selected.baseline, selected.candidate].map((row, i) => (
              <div className="eval-output-column" key={i}>
                <div className="eval-output-heading">
                  <span className="eval-run-role">{i ? 'Candidate' : 'Baseline'}</span>
                  <h3>{i ? data.candidate.name : data.baseline.name}</h3>
                  {row && (
                    <div className="eval-output-meta">
                      <span>{duration(row.latencyMs)}</span>
                      <span>{money(row.costUsd)}</span>
                      {row.traceId && (
                        <Button
                          onClick={() => {
                            setTraceId(row.traceId);
                            setSelected(null);
                          }}
                        >
                          Open trace
                          <ArrowRight size={12} />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {row ? (
                  <>
                    <ErrorBox message={row.error || ''} />
                    <JsonBlock label="Input" value={row.input} />
                    <JsonBlock label="Expected (recorded)" value={row.expected} />
                    <JsonBlock label="Output" value={row.output} />
                    {Object.keys(row.scoreErrors).length > 0 && (
                      <JsonBlock label="Scorer errors" value={row.scoreErrors} />
                    )}
                  </>
                ) : (
                  <div className="eval-no-ground-truth">
                    <strong>No matching case</strong>
                    <p>This run did not record the same dataset row and trial.</p>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="table-wrap eval-modal-score-table">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(selected.deltas).map((id) => (
                  <tr key={id}>
                    <td>{scoreName(id)}</td>
                    <td>
                      <Score value={selected.baseline?.scores[id]} />
                    </td>
                    <td>
                      <Score value={selected.candidate?.scores[id]} />
                    </td>
                    <td>
                      <Score value={selected.deltas[id]} delta />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.warning && <div className="warning-banner">{data.warning}</div>}
        </Modal>
      )}
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}
    </div>
  );
}
