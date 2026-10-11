import { useState } from 'react';
import { usePermissions } from './session';
import {
  ArrowRight,
  Check,
  CheckCheck,
  Clock3,
  Code2,
  Copy,
  FileCode2,
  History,
  KeyRound,
  MessageSquare,
  Play,
  Plus,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import type {
  Annotation,
  ApiKey,
  Json,
  Prompt,
  Scorer,
  ServerInfo,
  TaskConfig,
} from '../shared/types';
import {
  TOKEN_KEY,
  api,
  copy,
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
  Back,
  Badge,
  Button,
  Empty,
  ErrorBox,
  External,
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
import { TraceDrawer } from './App';
export function PromptsPage() {
  const { projectId, refresh } = useWorkspace();
  const list = useData<Prompt[]>(`/prompts?${qs({ projectId })}`, refresh);
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<Prompt | null>(null);
  return (
    <>
      <PageHeader
        eyebrow="GIVE YOUR AGENTS DIRECTION"
        title="Prompts"
        description="Version the instructions behind your application. Keep every iteration."
        actions={
          <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            Create prompt
          </Button>
        }
      />
      <ErrorBox message={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="prompt-grid">
          {list.data.map((p) => (
            <button key={p.id} className="prompt-card" onClick={() => setSelected(p)}>
              <div className="prompt-card-head">
                <span className="dataset-icon">
                  <MessageSquare size={20} />
                </span>
                <Badge>v{p.version}</Badge>
              </div>
              <h3>{p.name}</h3>
              <p>{p.description || 'A reusable, versioned prompt.'}</p>
              <pre>{p.template}</pre>
              <div>
                <span className="code-tag">{p.model || 'No model specified'}</span>
                <span className="muted small-text">{date(p.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="One place for every prompt"
          description="Create a prompt and preserve each revision as your application evolves."
          action={
            <Button permission="write" onClick={() => setCreate(true)}>
              Create your first prompt
            </Button>
          }
        />
      )}{' '}
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
      title={prompt ? prompt.name : 'Create a prompt'}
      description={
        prompt
          ? 'Save your changes as a new, immutable version.'
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
          <Field label="Load a previous version">
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
            placeholder="Instructions and boundaries for the model…"
          />
        </Field>
        <Field label="User prompt template">
          <textarea
            className="code-input tall"
            required
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </Field>
        <Field
          label="Model"
          hint="Model metadata; if omitted on creation, the server default is used. Saving a prompt does not make a model call."
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
  const { projectId, refresh, refreshAll, notify } = useWorkspace();
  const info = useData<ServerInfo>('/info', refresh);
  const prompts = useData<Prompt[]>(`/prompts?${qs({ projectId })}`, refresh);
  const [type, setType] = useState<TaskConfig['type']>('template');
  const [template, setTemplate] = useState('{{input}}');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [input, setInput] = useState('{\n  "message": "Hello, MindTrust"\n}');
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
      <PageHeader
        eyebrow="A SMALL CHANGE. A BETTER ANSWER."
        title="Playground"
        description="Try a prompt, inspect the result, and keep a trace of what happened."
      />
      <div className="playground-grid">
        <Section title="Configuration" detail="Test an idea before putting it in an experiment.">
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
            <Field label="Execution mode">
              <select value={type} onChange={(e) => setType(e.target.value as TaskConfig['type'])}>
                <option value="template">Template · deterministic, no model call</option>
                <option value="echo">Echo input · no model call</option>
                <option value="openai" disabled={!info.data?.providerConfigured}>
                  Model provider
                  {!info.data?.providerConfigured ? ' · configure on server first' : ''}
                </option>
              </select>
            </Field>
            <Field label="Load a saved prompt">
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
                <div className="info-banner">
                  Uses the server’s configured provider. Model charges may apply.
                </div>
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
              <Field
                label="Prompt template"
                hint="Use {{input}} or {{input.field}} to reference your JSON input."
              >
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
        <Section
          title="Result"
          detail={
            result
              ? 'This execution was saved to your project’s logs.'
              : 'Your output and execution details appear here.'
          }
        >
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
              <JsonBlock value={result.output} label="Output" />
              <div className="key-value">
                <span>Input tokens</span>
                <strong>{result.inputTokens}</strong>
                <span>Output tokens</span>
                <strong>{result.outputTokens}</strong>
                <span>Execution</span>
                <strong>
                  {resultType === 'openai' ? 'Model provider' : 'Local deterministic task'}
                </strong>
              </div>
              <Button onClick={() => setTraceId(result.traceId)}>
                Inspect trace
                <ArrowRight size={14} />
              </Button>
            </div>
          ) : (
            <div className="playground-empty">
              <div className="playground-orbit">
                <Terminal size={29} />
                <span />
                <i />
              </div>
              <h3>A place to explore.</h3>
              <p>
                Give your agent an input.
                <br />
                See exactly what comes back.
              </p>
              <Badge>No calls until you run</Badge>
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
        eyebrow="DEFINE WHAT GOOD LOOKS LIKE"
        title="Scorers"
        description="Repeatable checks for the behaviors that matter to your product."
        actions={
          <Button permission="write" variant="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            Create scorer
          </Button>
        }
      />
      <div className="info-banner">
        <ShieldCheck size={17} />
        <span>
          Deterministic checks run locally. No judge model calls, hidden model costs, or arbitrary
          server code.
        </span>
      </div>
      <ErrorBox message={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="scorer-grid">
          {list.data.map((s) => (
            <button className="scorer-card" key={s.id} onClick={() => setSelected(s)}>
              <div className="scorer-card-top">
                <span className="dataset-icon">
                  <ShieldCheck size={20} />
                </span>
                <Badge>Deterministic</Badge>
              </div>
              <h3>{s.name}</h3>
              <p>{s.description || 'A repeatable check for evaluation outputs.'}</p>
              <span className="code-tag">{s.type}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="Make quality measurable"
          description="Add a deterministic scorer to evaluate your outputs."
          action={
            <Button permission="write" onClick={() => setCreate(true)}>
              Create scorer
            </Button>
          }
        />
      )}{' '}
      {create && <CreateScorer onClose={() => setCreate(false)} />}{' '}
      {selected && (
        <Modal
          title={selected.name}
          description={selected.description}
          onClose={() => setSelected(null)}
        >
          <div className="key-value">
            <span>Type</span>
            <strong>{selected.type}</strong>
            <span>Created</span>
            <strong>{date(selected.createdAt)}</strong>
          </div>
          <JsonBlock label="Configuration" value={selected.config} />
          <p className="muted small-text">
            Scorers are snapshotted with each experiment. Create a new scorer to change the
            evaluation criteria.
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
  const action = useAction();
  return (
    <Modal
      title="Create a scorer"
      description="Clear rules. Consistent results. Every score can be inspected."
      onClose={onClose}
    >
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
                ...(expectedPath ? { expectedPath } : {}),
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
        <Field label="Scorer type">
          <select value={type} onChange={(e) => setType(e.target.value as Scorer['type'])}>
            <option value="exact_match">Exact match · output equals expected</option>
            <option value="contains">Contains · output includes expected text</option>
            <option value="json_valid">Valid JSON · output is valid JSON</option>
          </select>
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Output field path"
          hint="Optional dot path, such as answer.text. Empty checks the entire output."
        >
          <input
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
            placeholder="answer.text"
          />
        </Field>
        {type !== 'json_valid' && (
          <Field
            label="Expected field path"
            hint="Optional dot path. A missing field cannot pass a check."
          >
            <input
              value={expectedPath}
              onChange={(e) => setExpectedPath(e.target.value)}
              placeholder="answer.text"
            />
          </Field>
        )}
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
        eyebrow="HUMAN JUDGMENT, CAPTURED"
        title="Review"
        description="Collect feedback on traces and evaluation cases. Keep expectations explicit."
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
          <strong>Annotations</strong>
          <span className="count-label">{rows?.length || 0}</span>
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
                  <th>Assessment</th>
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
            title="Your expertise belongs in the loop"
            description="Open a trace or experiment case to add a review and expected output."
            action={<Button onClick={() => navigate('logs')}>Explore traces</Button>}
          />
        )}
      </div>
      {traceId && <TraceDrawer id={traceId} onClose={() => setTraceId(null)} />}{' '}
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
