import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Clock3,
  Database,
  FileJson,
  FlaskConical,
  GitCompareArrows,
  History,
  MoreHorizontal,
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
  Json,
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
  percent,
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
  Section,
  Stat,
  Status,
} from './ui';
import { Score, TraceDrawer } from './App';
export function DatasetsPage() {
  const { projectId, refresh } = useWorkspace();
  const { data, loading, error } = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState('');
  if (selected) return <DatasetView id={selected} onBack={() => setSelected(null)} />;
  const filtered = data?.filter((d) =>
    `${d.name} ${d.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="THE FOUNDATION OF GOOD EVALUATIONS"
        title="Datasets"
        description="Curate meaningful examples. Build a versioned source of truth."
        actions={
          <Button variant="primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            Create dataset
          </Button>
        }
      />
      <ErrorBox message={error} />
      <div className="panel">
        <div className="filter-bar">
          <div className="search-box">
            <Search size={16} />
            <input
              placeholder="Find a dataset…"
              aria-label="Search datasets"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="count-label">{filtered?.length || 0} datasets</span>
        </div>
        {loading && !data ? (
          <Loading />
        ) : filtered?.length ? (
          <div className="dataset-grid">
            {filtered.map((d) => (
              <button key={d.id} className="dataset-card" onClick={() => setSelected(d.id)}>
                <div className="dataset-card-top">
                  <span className="dataset-icon">
                    <Database size={21} />
                  </span>
                  <div className="tag-list">
                    {d.id === 'demo-dataset' && <Badge tone="amber">Synthetic</Badge>}
                    <Badge>v{d.version}</Badge>
                  </div>
                </div>
                <h3>{d.name}</h3>
                <p>{d.description || 'A versioned collection of evaluation examples.'}</p>
                <div className="dataset-card-bottom">
                  <span>
                    <FileJson size={13} />
                    {d.rowCount} examples
                  </span>
                  <ArrowRight size={15} />
                </div>
                <small>Updated {date(d.updatedAt)}</small>
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="Create a reliable starting point"
            description="Add your own examples, import JSON, or save a production trace."
            action={
              <Button onClick={() => setCreate(true)}>
                <Plus size={15} />
                Create dataset
              </Button>
            }
          />
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
    </>
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
    <Modal
      title="Create a dataset"
      description="Every change creates a snapshot you can evaluate again."
      onClose={onClose}
    >
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
  const { refresh, refreshAll, notify } = useWorkspace();
  const [version, setVersion] = useState('');
  const detail = useData<DatasetDetail>(
    `/datasets/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`,
    refresh,
  );
  const [editing, setEditing] = useState<DatasetRow | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<DatasetRow | null>(null);
  const action = useAction();
  const data = detail.data;
  const historical =
    !!version && !!data && Number(version) !== Math.max(...data.versions.map((v) => v.version));
  return (
    <>
      <Back onClick={onBack}>All datasets</Back>
      <PageHeader
        title={data?.dataset.name || 'Dataset'}
        description={data?.dataset.description}
        actions={
          <>
            <Button
              disabled={action.busy}
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
            <Button disabled={historical} onClick={() => setImporting(true)}>
              <ArrowUpFromLine size={15} />
              Import JSON
            </Button>
            <Button variant="primary" disabled={historical} onClick={() => setEditing('new')}>
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
          You’re viewing a historical snapshot. Select the latest version to edit examples.
        </div>
      )}
      <div className="panel">
        <div className="filter-bar">
          <span className="count-label">
            <Database size={15} />
            {data?.rows.length || 0} examples
          </span>
          <div className="filter-spacer" />
          <History size={15} />
          <select
            aria-label="Dataset version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            <option value="">
              Latest version{data ? ` · v${Math.max(...data.versions.map((v) => v.version))}` : ''}
            </option>
            {data?.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {v.rowCount} examples · {date(v.createdAt)}
              </option>
            ))}
          </select>
        </div>
        {detail.loading && !data ? (
          <Loading />
        ) : data?.rows.length ? (
          <div className="table-wrap">
            <table className="dataset-table">
              <thead>
                <tr>
                  <th>Input</th>
                  <th>Expected output</th>
                  <th>Tags</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button className="cell-json" onClick={() => setEditing(row)}>
                        {compact(row.input)}
                      </button>
                      <small className="row-id">{row.id.slice(0, 20)}</small>
                    </td>
                    <td>
                      <span className="cell-json">{compact(row.expected)}</span>
                    </td>
                    <td>
                      <div className="tag-list">
                        {row.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          onClick={() => setEditing(row)}
                          aria-label={historical ? 'View example' : 'Edit example'}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          disabled={historical}
                          onClick={() => setDeleting(row)}
                          aria-label="Delete example"
                        >
                          <Trash2 size={14} />
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
            title="No examples yet"
            description="Add an input and its expected output to start evaluating."
            action={
              <Button disabled={historical} onClick={() => setEditing('new')}>
                Add your first example
              </Button>
            }
          />
        )}
      </div>
      {editing && (
        <DatasetRowEditor
          datasetId={id}
          row={editing === 'new' ? undefined : editing}
          readOnly={historical}
          onClose={() => setEditing(null)}
        />
      )}{' '}
      {importing && <ImportRows id={id} onClose={() => setImporting(false)} />}{' '}
      {deleting && (
        <Modal
          title="Remove this example?"
          description="Previous dataset versions will retain this example. A new version will be created."
          onClose={() => setDeleting(null)}
        >
          <JsonBlock label="Input" value={deleting.input} />
          <ErrorBox message={action.error} />
          <div className="form-actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await api(
                    `/datasets/${encodeURIComponent(id)}/rows/${encodeURIComponent(deleting.id)}`,
                    {
                      method: 'DELETE',
                    },
                  );
                  setDeleting(null);
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
    </>
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
  const [input, setInput] = useState(JSON.stringify(row?.input ?? { question: '' }, null, 2));
  const [expected, setExpected] = useState(JSON.stringify(row?.expected ?? '', null, 2));
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
                  expected: parseJson(expected, 'Expected output'),
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
          <Field label="Expected output (JSON)">
            <textarea
              className="code-input tall"
              readOnly={readOnly}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </Field>
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
export function ExperimentsPage() {
  const { projectId, refresh } = useWorkspace();
  const list = useData<Experiment[]>(`/experiments?${qs({ projectId })}`, refresh);
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [compare, setCompare] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (list.data?.some((e) => ['running', 'queued'].includes(e.status))) {
      const timer = setInterval(list.reload, 1500);
      return () => clearInterval(timer);
    }
  }, [list.data, list.reload]);
  if (selected) return <ExperimentView id={selected} onBack={() => setSelected(null)} />;
  if (comparing && compare.length === 2)
    return (
      <CompareView
        baseline={compare[0]}
        candidate={compare[1]}
        onBack={() => setComparing(false)}
      />
    );
  const filtered = list.data?.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()));
  function toggle(id: string) {
    setCompare((c) =>
      c.includes(id) ? c.filter((v) => v !== id) : c.length < 2 ? [...c, id] : [c[1], id],
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="EVALUATE. COMPARE. IMPROVE."
        title="Experiments"
        description="Find out what works, with repeatable tests and evidence at every step."
        actions={
          <>
            <Button disabled={compare.length !== 2} onClick={() => setComparing(true)}>
              <GitCompareArrows size={16} />
              Compare{compare.length ? ` (${compare.length}/2)` : ''}
            </Button>
            <Button variant="primary" onClick={() => setCreate(true)}>
              <Plus size={16} />
              New experiment
            </Button>
          </>
        }
      />
      <ErrorBox message={list.error} />
      <div className="panel">
        <div className="filter-bar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="Search experiments"
              placeholder="Find an experiment…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="count-label">{filtered?.length || 0} experiments</span>
        </div>
        {list.loading && !list.data ? (
          <Loading />
        ) : filtered?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="checkbox-col" />
                  <th>Experiment</th>
                  <th>Status</th>
                  <th>Cases</th>
                  <th>Mean score</th>
                  <th>Scorers</th>
                  <th>Latency</th>
                  <th>Cost</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className={compare.includes(e.id) ? 'checked-row' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={compare.includes(e.id)}
                        onChange={() => toggle(e.id)}
                        aria-label={`Compare ${e.name}`}
                      />
                    </td>
                    <td>
                      <button className="row-title" onClick={() => setSelected(e.id)}>
                        <span className="table-icon">
                          <FlaskConical size={15} />
                        </span>
                        <span>
                          {e.name}
                          <small>
                            Dataset v{e.datasetVersion} · {e.trials}{' '}
                            {e.trials === 1 ? 'trial' : 'trials'}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Status value={e.status} />
                    </td>
                    <td className="tabular">
                      {e.completedCases}/{e.totalCases}
                    </td>
                    <td>
                      <Score value={meanScore(e.scores)} />
                    </td>
                    <td className="muted">{e.scorerIds.length}</td>
                    <td className="tabular">{duration(e.latencyMs)}</td>
                    <td className="tabular">
                      {money(e.costUsd)}
                      {e.unknownCostCount > 0 && (
                        <small className="muted block">{e.unknownCostCount} unknown</small>
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
            title="Better agents start with a baseline"
            description="Run an evaluation against a dataset, then compare your next change."
            action={<Button onClick={() => setCreate(true)}>Create an experiment</Button>}
          />
        )}
      </div>
      {compare.length > 0 && (
        <div className="comparison-bar">
          <div>
            <GitCompareArrows size={17} />
            <strong>{compare.length} of 2 selected</strong>
            <span>First selection is the baseline.</span>
          </div>
          <Button variant="ghost" onClick={() => setCompare([])}>
            Clear
          </Button>
          <Button
            variant="primary"
            disabled={compare.length !== 2}
            onClick={() => setComparing(true)}
          >
            Compare experiments
            <ArrowRight size={14} />
          </Button>
        </div>
      )}
      {create && (
        <CreateExperiment
          onClose={() => setCreate(false)}
          onCreated={(e) => {
            setCreate(false);
            setSelected(e.id);
          }}
        />
      )}
    </>
  );
}
function CreateExperiment({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (e: Experiment) => void;
}) {
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const datasets = useData<Dataset[]>(`/datasets?${qs({ projectId })}`, refresh);
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const info = useData<ServerInfo>('/info');
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState('');
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
function ExperimentView({ id, onBack }: { id: string; onBack: () => void }) {
  const { refresh, refreshAll, notify } = useWorkspace();
  const detail = useData<ExperimentDetail>(`/experiments/${encodeURIComponent(id)}`, refresh);
  const [selected, setSelected] = useState<EvalCase | null>(null);
  const [filter, setFilter] = useState('all');
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
  const rows = detail.data?.cases.filter((c) =>
    filter === 'all' || filter === 'errors'
      ? filter === 'all' || !!c.error
      : Object.values(c.scores).some((v) => v != null && v < 1),
  );
  return (
    <>
      <Back onClick={onBack}>All experiments</Back>
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
            <div className="experiment-state">
              <Status value={e.status} />
              <div className="progress-track">
                <i
                  style={{
                    width: `${e.totalCases ? (e.completedCases / e.totalCases) * 100 : 0}%`,
                  }}
                />
              </div>
              <span>
                {e.completedCases} / {e.totalCases} cases
              </span>
            </div>
            <div className="experiment-stats">
              {columns.map((s) => (
                <Stat
                  key={s.id}
                  label={s.name}
                  value={<Score value={e.scores[s.id]} />}
                  detail={s.type.replaceAll('_', ' ')}
                />
              ))}
              <Stat
                label="Mean case latency"
                value={duration(e.latencyMs)}
                detail="Measured execution time"
              />
              <Stat
                label="Recorded cost"
                value={money(e.costUsd)}
                detail={
                  e.unknownCostCount
                    ? `${e.unknownCostCount} cases with unknown cost`
                    : 'All completed cases accounted for'
                }
              />
            </div>
            <div className="panel">
              <div className="filter-bar">
                <strong>Evaluation cases</strong>
                <span className="count-label">{rows?.length || 0} results</span>
                <div className="filter-spacer" />
                <select
                  value={filter}
                  aria-label="Filter cases"
                  onChange={(ev) => setFilter(ev.target.value)}
                >
                  <option value="all">All cases</option>
                  <option value="failures">Scores below 100%</option>
                  <option value="errors">Execution errors</option>
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
    </>
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
  const result = useData<Comparison>(`/compare?${qs({ baseline, candidate })}`, refresh);
  const scorers = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const [selected, setSelected] = useState<ComparisonRow | null>(null);
  const [swapped, setSwapped] = useState(false);
  const reverse = useData<Comparison>(
    swapped ? `/compare?${qs({ baseline: candidate, candidate: baseline })}` : null,
    refresh,
  );
  const data = swapped ? reverse.data : result.data;
  const loading = swapped ? reverse.loading : result.loading;
  const error = swapped ? reverse.error : result.error;
  return (
    <>
      <Back onClick={onBack}>All experiments</Back>
      <PageHeader
        eyebrow="MEASURE THE DIFFERENCE"
        title="Compare experiments"
        description="Cases aligned by dataset row and trial. Positive score changes are improvements."
        actions={
          <Button onClick={() => setSwapped((v) => !v)}>
            <ArrowLeftRight size={15} />
            Swap baseline
          </Button>
        }
      />
      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            {data.warning && <div className="warning-banner">{data.warning}</div>}
            <div className="compare-heading">
              <div>
                <span className="eyebrow">BASELINE</span>
                <h2>{data.baseline.name}</h2>
                <Badge>Dataset v{data.baseline.datasetVersion}</Badge>
              </div>
              <ArrowRight size={24} />
              <div>
                <span className="eyebrow">CANDIDATE</span>
                <h2>{data.candidate.name}</h2>
                <Badge>Dataset v{data.candidate.datasetVersion}</Badge>
              </div>
            </div>
            <div className="experiment-stats">
              {Object.entries(data.deltas).map(([id, delta]) => (
                <Stat
                  key={id}
                  label={scorers.data?.find((s) => s.id === id)?.name || id}
                  value={<Score value={delta} delta />}
                  detail={
                    data.comparable ? 'Mean score change' : 'Coverage differs — compare with care'
                  }
                />
              ))}
            </div>
            <Section
              title="Case-by-case comparison"
              detail="Open a row to inspect both outputs and exact scores."
            >
              <div className="table-wrap">
                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th>Input</th>
                      <th>Baseline output</th>
                      <th>Candidate output</th>
                      {Object.keys(data.deltas).map((id) => (
                        <th key={id}>Δ {scorers.data?.find((s) => s.id === id)?.name || id}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={`${r.rowId}-${r.trial}-${i}`}>
                        <td>
                          <button className="cell-json" onClick={() => setSelected(r)}>
                            {compact(r.input)}
                          </button>
                          <small className="row-id">Trial {r.trial}</small>
                        </td>
                        <td>
                          <span className="cell-json">
                            {r.baseline ? compact(r.baseline.output) : 'Unmatched'}
                          </span>
                        </td>
                        <td>
                          <span className="cell-json">
                            {r.candidate ? compact(r.candidate.output) : 'Unmatched'}
                          </span>
                        </td>
                        {Object.keys(data.deltas).map((id) => (
                          <td key={id}>
                            <Score value={r.deltas[id]} delta />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )
      )}
      {selected && (
        <Modal
          title="Compare outputs"
          description={`Row ${selected.rowId} · trial ${selected.trial}`}
          onClose={() => setSelected(null)}
          wide
        >
          <JsonBlock label="Input" value={selected.input} />
          <div className="form-columns">
            <div>
              <JsonBlock label="Baseline output" value={selected.baseline?.output ?? 'Unmatched'} />
              <JsonBlock label="Baseline scores" value={selected.baseline?.scores ?? {}} />
            </div>
            <div>
              <JsonBlock
                label="Candidate output"
                value={selected.candidate?.output ?? 'Unmatched'}
              />
              <JsonBlock label="Candidate scores" value={selected.candidate?.scores ?? {}} />
            </div>
          </div>
          <JsonBlock label="Score changes" value={selected.deltas} />
        </Modal>
      )}
    </>
  );
}

function meanScore(scores: Record<string, number | null>) {
  const values = Object.values(scores).filter((s): s is number => s !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
