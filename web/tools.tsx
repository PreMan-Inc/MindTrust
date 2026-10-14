import { useState } from 'react';
import { ArrowRight, Check, CheckCheck, Play, Plus, Search, Terminal } from 'lucide-react';
import type { Annotation, Json, Prompt, Scorer, ServerInfo, TaskConfig } from '../shared/types';
import {
  date,
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
  Status,
} from './ui';
import { TraceDrawer } from './observability';
export function PromptsPage() {
  const { projectId, refresh } = useWorkspace();
  const list = useData<Prompt[]>(`/prompts?${qs({ projectId })}`, refresh);
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<Prompt | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('updated');
  const filtered = (list.data || [])
    .filter((p) =>
      `${p.name} ${p.description} ${p.model} ${p.template}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
    );
  return (
    <>
      <PageHeader
        title="Prompts"
        actions={
          <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            Create prompt
          </Button>
        }
      />
      <div className="prompt-toolbar">
        <label className="prompt-search">
          <Search size={16} />
          <input
            aria-label="Search prompts"
            placeholder="Search prompts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <span className="muted">{filtered.length} prompts</span>
        <select aria-label="Sort prompts" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
      <ErrorBox message={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Version</th>
                <th>Model</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button className="row-title" onClick={() => setSelected(p)}>
                      <span>
                        {p.name}
                        {p.description && <small>{p.description}</small>}
                      </span>
                    </button>
                  </td>
                  <td className="mono">v{p.version}</td>
                  <td className="muted">{p.model || '—'}</td>
                  <td className="muted nowrap">{date(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty title="No matching prompts" description="Try another search." />
          )}
        </div>
      ) : (
        <Empty
          title="No prompts yet"
          description="Create a prompt to save and version its instructions."
        />
      )}
      {(create || selected) && (
        <PromptEditor
          prompt={selected || undefined}
          onClose={() => {
            setCreate(false);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}
function PromptEditor({ prompt, onClose }: { prompt?: Prompt; onClose: () => void }) {
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const detail = useData<{ prompt: Prompt; versions: Prompt[] }>(
    prompt ? `/prompts/${encodeURIComponent(prompt.id)}` : null,
    refresh,
  );
  const [name, setName] = useState(prompt?.name || '');
  const [description, setDescription] = useState(prompt?.description || '');
  const [system, setSystem] = useState(prompt?.system || '');
  const [template, setTemplate] = useState(prompt?.template || '{{input}}');
  const [model, setModel] = useState(prompt?.model || '');
  const [version, setVersion] = useState(prompt?.version || 1);
  const action = useAction();
  function loadVersion(v: number) {
    const p = detail.data?.versions.find((p) => p.version === v);
    if (p) {
      setVersion(v);
      setTemplate(p.template);
      setSystem(p.system);
      setModel(p.model);
      setDescription(p.description);
    }
  }
  return (
    <Modal
      title={prompt ? prompt.name : 'Create prompt'}
      description={
        prompt
          ? 'Changes save as a new version.'
          : 'Use {{input}} or {{input.field}} variables in the template.'
      }
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            await post(prompt ? `/prompts/${encodeURIComponent(prompt.id)}/versions` : '/prompts', {
              projectId,
              name,
              description,
              system,
              template,
              ...(model.trim() ? { model: model.trim() } : {}),
            });
            refreshAll();
            notify(prompt ? 'New prompt version saved' : 'Prompt created');
            onClose();
          })
        }
      >
        {prompt && (
          <Field label="Version">
            <select value={version} onChange={(e) => loadVersion(Number(e.target.value))}>
              {detail.data?.versions.map((p) => (
                <option key={p.version} value={p.version}>
                  v{p.version} · {date(p.updatedAt)}
                </option>
              )) || <option value={version}>v{version}</option>}
            </select>
          </Field>
        )}
        {!prompt && (
          <Field label="Name">
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Support assistant"
            />
          </Field>
        )}
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="System prompt">
          <textarea
            className="code-input"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="Instructions for the model…"
          />
        </Field>
        <Field label="Prompt template">
          <textarea
            className="code-input tall"
            required
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </Field>
        <Field
          label="Model"
          hint={
            prompt
              ? 'Metadata only; saving does not call the model.'
              : 'Leave blank for the server default. Saving does not call the model.'
          }
        >
          <input
            required={!!prompt}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. gpt-4.1-mini"
          />
        </Field>
        <ErrorBox message={action.error || detail.error} />
        <FormActions
          busy={action.busy}
          label={prompt ? 'Save new version' : 'Create prompt'}
          onCancel={onClose}
        />
      </Form>
    </Modal>
  );
}
interface PlaygroundResult {
  output: Json;
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  traceId: string;
}
export function PlaygroundPage() {
  const { projectId, refresh, refreshAll } = useWorkspace();
  const info = useData<ServerInfo>('/info', refresh);
  const prompts = useData<Prompt[]>(`/prompts?${qs({ projectId })}`, refresh);
  const [type, setType] = useState<TaskConfig['type']>('template');
  const [template, setTemplate] = useState('{{input}}');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [input, setInput] = useState('{\n  "message": "Hello, Verus"\n}');
  const [temperature, setTemperature] = useState(0);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [resultType, setResultType] = useState<TaskConfig['type']>('template');
  const [traceId, setTraceId] = useState<string | null>(null);
  const [loadedPrompt, setLoadedPrompt] = useState('');
  const action = useAction();
  function loadPrompt(id: string) {
    setLoadedPrompt(id);
    const p = prompts.data?.find((p) => p.id === id);
    if (p) {
      setTemplate(p.template);
      setSystem(p.system);
      if (p.model) setModel(p.model);
    }
  }
  return (
    <>
      <PageHeader title="Playground" />
      <div className="playground-grid">
        <Section title="Request">
          <Form
            onSubmit={() =>
              action.run(async () => {
                setResult(null);
                const task: TaskConfig =
                  type === 'echo'
                    ? { type }
                    : type === 'template'
                      ? { type, template }
                      : { type, template, system, model, temperature };
                const r = await post<PlaygroundResult>('/playground', {
                  projectId,
                  task,
                  input: parseJson(input),
                });
                setResult(r);
                setResultType(type);
                refreshAll();
              })
            }
          >
            <Field label="Mode">
              <select value={type} onChange={(e) => setType(e.target.value as TaskConfig['type'])}>
                <option value="template">Template · local</option>
                <option value="echo">Echo · local</option>
                <option value="openai" disabled={!info.data?.providerConfigured}>
                  Model provider
                  {!info.data?.providerConfigured ? ' · not configured' : ''}
                </option>
              </select>
            </Field>
            <Field label="Saved prompt">
              <select value={loadedPrompt} onChange={(e) => loadPrompt(e.target.value)}>
                <option value="">Start from scratch</option>
                {prompts.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · v{p.version}
                  </option>
                ))}
              </select>
            </Field>
            {type === 'openai' && (
              <>
                <p className="muted small-text">
                  Uses the configured provider; model charges may apply.
                </p>
                <div className="form-columns">
                  <Field label="Model">
                    <input required value={model} onChange={(e) => setModel(e.target.value)} />
                  </Field>
                  <Field label="Temperature">
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={temperature}
                      onChange={(e) => setTemperature(Number(e.target.value))}
                    />
                  </Field>
                </div>
                <Field label="System prompt">
                  <textarea value={system} onChange={(e) => setSystem(e.target.value)} />
                </Field>
              </>
            )}
            {type !== 'echo' && (
              <Field label="Prompt template" hint="Variables: {{input}} or {{input.field}}.">
                <textarea
                  className="code-input"
                  required
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                />
              </Field>
            )}
            <Field label="Input (JSON)">
              <textarea
                className="code-input tall"
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </Field>
            <ErrorBox message={action.error || info.error} />
            <div className="form-actions">
              <Button variant="primary" type="submit" disabled={action.busy}>
                <Play size={14} />
                {action.busy ? 'Running…' : type === 'openai' ? 'Run model' : 'Run locally'}
              </Button>
            </div>
          </Form>
        </Section>
        <Section title="Output">
          {action.busy ? (
            <Loading />
          ) : result ? (
            <div className="playground-result">
              <div className="result-metrics">
                <Badge tone="green">
                  <Check size={12} />
                  Completed
                </Badge>
                <span>{duration(result.latencyMs)}</span>
                <span>{money(result.costUsd)}</span>
              </div>
              <JsonBlock value={result.output} />
              <details className="compact-disclosure">
                <summary>Run details</summary>
                <div className="key-value">
                  <span>Input tokens</span>
                  <strong>{result.inputTokens}</strong>
                  <span>Output tokens</span>
                  <strong>{result.outputTokens}</strong>
                  <span>Execution</span>
                  <strong>{resultType === 'openai' ? 'Model provider' : 'Local'}</strong>
                </div>
              </details>
              <Button onClick={() => setTraceId(result.traceId)}>
                Inspect trace
                <ArrowRight size={14} />
              </Button>
            </div>
          ) : (
            <div className="playground-empty">
              <Terminal size={22} />
              <p>Run a prompt to see its output.</p>
            </div>
          )}
        </Section>
      </div>
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}
    </>
  );
}
export function ScorersPage() {
  const { projectId, refresh } = useWorkspace();
  const list = useData<Scorer[]>(`/scorers?${qs({ projectId })}`, refresh);
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<Scorer | null>(null);
  return (
    <>
      <PageHeader
        title="Scorers"
        description="Local deterministic checks."
        actions={
          <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            Create scorer
          </Button>
        }
      />
      <ErrorBox message={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scorer</th>
                <th>Check</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button className="row-title" onClick={() => setSelected(s)}>
                      <span>
                        {s.name}
                        {s.description && <small>{s.description}</small>}
                      </span>
                    </button>
                  </td>
                  <td className="muted">{scorerLabel(s.type)}</td>
                  <td className="muted nowrap">{date(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No scorers yet" description="Create a check for your evaluation outputs." />
      )}
      {create && <CreateScorer onClose={() => setCreate(false)} />}
      {selected && (
        <Modal
          title={selected.name}
          description={selected.description}
          onClose={() => setSelected(null)}
        >
          <div className="key-value">
            <span>Type</span>
            <strong>{scorerLabel(selected.type)}</strong>
            <span>Created</span>
            <strong>{date(selected.createdAt)}</strong>
          </div>
          <JsonBlock label="Configuration" value={selected.config} />
          <p className="muted small-text">
            Each experiment keeps a snapshot. Create another scorer to change its criteria.
          </p>
        </Modal>
      )}
    </>
  );
}
function CreateScorer({ onClose }: { onClose: () => void }) {
  const { projectId, refreshAll, notify } = useWorkspace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<Scorer['type']>('exact_match');
  const [outputPath, setOutputPath] = useState('');
  const [expectedPath, setExpectedPath] = useState('');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [prompt, setPrompt] = useState(
    'Question:\n{{input}}\n\nExpected answer:\n{{expected}}\n\nSubmitted answer:\n{{output}}\n\nIs the submitted answer correct?',
  );
  const [choices, setChoices] = useState('correct=1\npartially_correct=0.5\nincorrect=0');
  const [maxTokensPerRun, setMaxTokensPerRun] = useState('100000');
  const action = useAction();
  const judge = type === 'llm_judge';
  return (
    <Modal title="Create scorer" onClose={onClose}>
      <Form
        onSubmit={() =>
          action.run(async () => {
            await post('/scorers', {
              projectId,
              name,
              description,
              type,
              config: {
                ...(outputPath ? { outputPath } : {}),
                ...(expectedPath && !judge ? { expectedPath } : {}),
                ...(judge
                  ? {
                      model,
                      prompt,
                      choices: parseChoices(choices),
                      maxTokensPerRun: Number(maxTokensPerRun),
                    }
                  : {}),
              },
            });
            refreshAll();
            notify('Scorer created');
            onClose();
          })
        }
      >
        <Field label="Name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Exact answer match"
          />
        </Field>
        <Field label="Check">
          <select value={type} onChange={(e) => setType(e.target.value as Scorer['type'])}>
            <option value="exact_match">Exact match · output equals expected</option>
            <option value="contains">Contains · output includes expected text</option>
            <option value="json_valid">Valid JSON · output is valid JSON</option>
            <option value="llm_judge">Model judge · a model grades the output</option>
          </select>
        </Field>
        {judge && (
          <>
            <Field label="Judge model" hint="Called through the server's configured provider.">
              <input required value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field
              label="Grading prompt"
              hint="Use {{input}}, {{output}} and {{expected}}. {{output}} is required."
            >
              <textarea
                required
                rows={7}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <Field label="Labels and scores" hint="One label=score per line; scores from 0 to 1.">
              <textarea
                required
                rows={3}
                value={choices}
                onChange={(e) => setChoices(e.target.value)}
              />
            </Field>
            <Field
              label="Judge token budget per run"
              hint="Cases beyond the budget are reported as scorer errors, never as passes."
            >
              <input
                required
                type="number"
                min={1}
                value={maxTokensPerRun}
                onChange={(e) => setMaxTokensPerRun(e.target.value)}
              />
            </Field>
          </>
        )}
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <details className="compact-disclosure">
          <summary>Field paths · optional</summary>
          <Field label="Output field path" hint="Leave blank to check the entire output.">
            <input
              value={outputPath}
              onChange={(e) => setOutputPath(e.target.value)}
              placeholder="answer.text"
            />
          </Field>
          {type !== 'json_valid' && !judge && (
            <Field label="Expected field path" hint="Missing fields cannot pass.">
              <input
                value={expectedPath}
                onChange={(e) => setExpectedPath(e.target.value)}
                placeholder="answer.text"
              />
            </Field>
          )}
        </details>
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Create scorer" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
export function ReviewPage() {
  const { projectId, refresh, navigate } = useWorkspace();
  const list = useData<Annotation[]>(`/annotations?${qs({ projectId })}`, refresh);
  const [filter, setFilter] = useState('all');
  const [traceId, setTraceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Annotation | null>(null);
  const rows = list.data?.filter((a) => filter === 'all' || a.label === filter);
  return (
    <>
      <PageHeader
        title="Review"
        actions={
          <Button onClick={() => navigate('logs')}>
            Review a trace
            <ArrowRight size={14} />
          </Button>
        }
      />
      <ErrorBox message={list.error} />
      <div className="panel">
        <div className="filter-bar">
          <span className="muted">{rows?.length || 0} reviews</span>
          <div className="filter-spacer" />
          <select
            aria-label="Review status filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All labels</option>
            <option value="correct">Correct</option>
            <option value="incorrect">Incorrect</option>
            <option value="needs_review">Needs review</option>
          </select>
        </div>
        {list.loading && !list.data ? (
          <Loading />
        ) : rows?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Label</th>
                  <th>Comment</th>
                  <th>Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        className="row-title"
                        onClick={() =>
                          a.targetType === 'trace' ? setTraceId(a.targetId) : setSelected(a)
                        }
                      >
                        <span className="table-icon">
                          <BookReviewIcon />
                        </span>
                        <span>
                          {a.targetType === 'trace' ? 'Trace' : 'Evaluation case'}
                          <small>{a.targetId.slice(0, 22)}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Status value={a.label} />
                    </td>
                    <td>
                      <button className="cell-json" onClick={() => setSelected(a)}>
                        {a.comment || 'No comment'}
                      </button>
                    </td>
                    <td className="muted nowrap">{date(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={filter === 'all' ? 'No reviews yet' : 'No matching reviews'}
            description={
              filter === 'all'
                ? 'Open a trace or evaluation case to add feedback.'
                : 'Choose another label.'
            }
          />
        )}
      </div>
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}
      {selected && (
        <Modal
          title="Review detail"
          description={selected.targetId}
          onClose={() => setSelected(null)}
        >
          <Status value={selected.label} />
          <p>{selected.comment || 'No comment'}</p>
          <JsonBlock label="Expected output" value={selected.expected} />
          <span className="muted small-text">{date(selected.createdAt)}</span>
        </Modal>
      )}
    </>
  );
}
function BookReviewIcon() {
  return <CheckCheck size={15} />;
}

function parseChoices(text: string): Record<string, number> {
  const choices: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const at = line.lastIndexOf('=');
    const label = line.slice(0, at).trim(),
      score = Number(line.slice(at + 1));
    if (at < 1 || !label || !Number.isFinite(score))
      throw new Error(`Expected label=score, got "${line.trim()}"`);
    choices[label] = score;
  }
  return choices;
}

function scorerLabel(type: Scorer['type']) {
  return {
    exact_match: 'Exact match',
    contains: 'Contains',
    json_valid: 'Valid JSON',
    llm_judge: 'Model judge',
  }[type];
}
