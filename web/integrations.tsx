import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpFromLine,
  Braces,
  Check,
  ChevronRight,
  Copy,
  Database,
  FileJson,
  KeyRound,
  Plug,
  ShieldCheck,
  Terminal,
  Waypoints,
} from 'lucide-react';
import type { Dataset, DatasetDetail, Project } from '../shared/types';
import { api, copy, parseJson, post, qs, useAction, useData, useWorkspace } from './lib';
import { usePermissions } from './session';
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Form,
  FormActions,
  Modal,
  PageHeader,
  Section,
} from './ui';
export function integrationBaseUrl() {
  return import.meta.env.DEV ? `${location.protocol}//${location.hostname}:4310` : location.origin;
}
export function IntegrationsPage() {
  const { projectId, project, refresh, notify, navigate } = useWorkspace();
  const { canAdmin, canWrite } = usePermissions();
  const [tab, setTab] = useState('braintrust');
  const [importing, setImporting] = useState(false);
  const action = useAction();
  const datasets = useData<Dataset[]>(projectId ? `/datasets?${qs({ projectId })}` : null, refresh);
  const base = integrationBaseUrl();
  const curl = `export MINDTRUST_URL=${JSON.stringify(base)}\nexport MINDTRUST_API_KEY="<your-scoped-api-key>"\n\ncurl "$MINDTRUST_URL/api/traces" \\\n  -H "Authorization: Bearer $MINDTRUST_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  --data-binary @- <<'JSON'\n${JSON.stringify({ projectId: projectId || '<project-id>', traces: [{ name: 'my-agent', input: { message: 'Hello' }, output: { answer: 'Hello from MindTrust' }, status: 'ok', metadata: { source: 'integration-example', synthetic: true } }] }, null, 2)}\nJSON`;
  const native = `import { MindTrust } from "./sdk/index.mjs";\n\nconst client = new MindTrust({\n  baseUrl: ${JSON.stringify(base)},\n  projectId: ${JSON.stringify(projectId || '<project-id>')},\n  apiKey: process.env.MINDTRUST_API_KEY,\n});\n\nawait client.trace("support-agent", {\n  input: { message: "Hello" }, kind: "agent",\n}, async (span) => {\n  return "Agent response";\n});\nawait client.flush();`;
  const otlp = `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces\nOTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<your-key>,x-mindtrust-project-id=${encodeURIComponent(projectId || '<project-id>')}`;
  return (
    <>
      <PageHeader
        eyebrow="BRING YOUR WORKFLOWS WITH YOU"
        title="Connect to MindTrust"
        description="Start with one project. Verify your traces and evaluations before moving more workloads."
        actions={
          canAdmin ? (
            <Button onClick={() => navigate('settings')}>
              <KeyRound size={14} />
              Manage API keys
            </Button>
          ) : undefined
        }
      />
      <div className="integration-context">
        <Plug size={17} />
        <div>
          <strong>{project?.name || 'Choose or create a project first'}</strong>
          <span>{projectId || 'Your administrator can assign a project to your account.'}</span>
        </div>
        <Badge>{canWrite ? 'Write access' : 'Read only'}</Badge>
      </div>
      <div className="tabs settings-tabs" role="tablist" aria-label="Integration options">
        {[
          { id: 'braintrust', name: 'Braintrust migration' },
          { id: 'native', name: 'Native SDK & API' },
          { id: 'otel', name: 'OpenTelemetry' },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <ErrorBox message={action.error} />
      {tab === 'braintrust' && (
        <>
          <div className="migration-intro">
            <div>
              <span className="integration-icon">
                <ArrowUpFromLine size={23} />
              </span>
              <h2>Move deliberately. Keep the evidence.</h2>
              <p>
                MindTrust supports a defined subset of Braintrust workflows. Treat the transition as
                a tested migration, with your current system available until you’ve checked the
                results.
              </p>
            </div>
            <div className="migration-checklist">
              <span>
                <Check size={14} />
                Use a scoped MindTrust API key
              </span>
              <span>
                <Check size={14} />
                Verify outputs, scores, and nested spans
              </span>
              <span>
                <Check size={14} />
                Keep historical data until reconciliation
              </span>
            </div>
          </div>
          <Section
            title="Existing dataset exports"
            detail="Import JSON records into a versioned MindTrust dataset."
            actions={
              <Button
                variant="primary"
                disabled={!projectId || !canWrite}
                onClick={() => setImporting(true)}
              >
                <ArrowUpFromLine size={14} />
                Import dataset JSON
              </Button>
            }
          >
            <div className="integration-section-body">
              <div className="compat-grid">
                <div>
                  <Badge tone="green">Supported</Badge>
                  <h3>Dataset rows</h3>
                  <p>
                    Input, expected output, metadata, tags, and row IDs are preserved. Braintrust{' '}
                    <code>_id</code> is accepted when <code>id</code> is absent. Omitting an
                    expected value stays different from expecting JSON <code>null</code>.
                  </p>
                </div>
                <div>
                  <Badge tone="amber">Check your export</Badge>
                  <h3>Rows, not a full workspace</h3>
                  <p>
                    This imports a JSON array of dataset examples. It does not migrate access
                    policies, attachments, saved queries, model credentials, or arbitrary hosted
                    functions.
                  </p>
                </div>
              </div>
              <div className="migration-validation">
                <ShieldCheck size={17} />
                <p>
                  After import, compare row counts and sample inputs. Run a small evaluation and
                  inspect its scores before using the migrated dataset in release decisions.
                </p>
              </div>
            </div>
          </Section>
          <BraintrustCompatibility
            baseUrl={base}
            projectId={projectId}
            projectName={project?.name || ''}
          />
        </>
      )}
      {tab === 'native' && (
        <div className="integration-grid">
          <CodeSection
            title="Bundled Node.js SDK"
            detail="Use sdk/index.mjs from the MindTrust repository in your server application."
            code={native}
          />
          <CodeSection
            title="Native HTTP ingestion"
            detail="Send JSON traces with a scoped editor key. The example is explicitly synthetic."
            code={curl}
          />
        </div>
      )}
      {tab === 'otel' && (
        <>
          <div className="info-banner">
            <Waypoints size={17} />
            <span>
              MindTrust accepts OTLP/HTTP <strong>JSON</strong> at <code>/v1/traces</code>. Protobuf
              and gRPC payloads are not supported by this receiver.
            </span>
          </div>
          <CodeSection
            title="OTLP JSON connection"
            detail="Only use exporters that support HTTP JSON. Point them at the selected project and verify the resulting span tree."
            code={otlp}
          />
          <Section title="Verify the integration">
            <div className="integration-section-body">
              <ol className="integration-steps">
                <li>Send a short trace with a root span and a nested child span.</li>
                <li>
                  Open Logs and confirm the trace ID, parent relationship, timestamps, status, and
                  recorded metrics.
                </li>
                <li>
                  Keep unknown costs unknown. Add trusted cost values at your application boundary
                  if your exporter does not report them.
                </li>
              </ol>
              <Button onClick={() => navigate('logs')} disabled={!projectId}>
                Inspect project logs
                <ArrowRight size={14} />
              </Button>
            </div>
          </Section>
        </>
      )}
      {importing && (
        <DatasetMigration datasets={datasets.data || []} onClose={() => setImporting(false)} />
      )}
    </>
  );
}
function CodeSection({ title, detail, code }: { title: string; detail: string; code: string }) {
  const { notify } = useWorkspace();
  const action = useAction();
  return (
    <Section
      title={title}
      detail={detail}
      actions={
        <Button
          onClick={() =>
            action.run(async () => {
              await copy(code);
              notify('Configuration copied');
            })
          }
        >
          <Copy size={13} />
          Copy
        </Button>
      }
    >
      <ErrorBox message={action.error} />
      <pre className="sdk-snippet integration-code">{code}</pre>
    </Section>
  );
}
function BraintrustCompatibility({
  baseUrl,
  projectId,
  projectName,
}: {
  baseUrl: string;
  projectId: string;
  projectName: string;
}) {
  const environment = `npm install braintrust@3.37.2\n\nexport BRAINTRUST_APP_URL=${JSON.stringify(baseUrl)}\nexport BRAINTRUST_API_URL=${JSON.stringify(baseUrl)}\nexport BRAINTRUST_API_KEY="<your-scoped-MindTrust-key>"\nexport BRAINTRUST_ORG_NAME="MindTrust"`;
  const logger = `import { initLogger, wrapTraced } from "braintrust";\n\nconst logger = initLogger({\n  projectName: ${JSON.stringify(projectName || '<existing-MindTrust-project-name>')},\n  asyncFlush: false,\n});\n\nconst normalize = wrapTraced(\n  async (input) => input.toUpperCase(),\n  { name: "normalize" },\n);\n\nawait logger.traced(async (span) => {\n  span.log({ input: "hello", metadata: { synthetic: true } });\n  const output = await normalize("hello");\n  span.log({ output });\n  return output;\n}, { name: "migration-smoke-check" });\n\nawait logger.flush();`;
  return (
    <>
      <Section
        title="Braintrust SDK compatibility"
        detail="Contract-tested with the official JavaScript SDK braintrust@3.37.2."
        actions={<Badge tone="green">Verified subset</Badge>}
      >
        <div className="integration-section-body">
          <div className="compat-grid">
            <div>
              <Badge tone="green">Covered by contract tests</Badge>
              <h3>Core application workflows</h3>
              <p>
                <code>initLogger</code>, nested <code>wrapTraced</code> spans, flush and feedback;
                dataset insert, update, delete, fetch and version reads; client-side{' '}
                <code>Eval</code> with tasks and scorers stored as native MindTrust experiments.
              </p>
            </div>
            <div>
              <Badge tone="amber">Outside this contract</Badge>
              <h3>Features that need a separate migration</h3>
              <p>
                Arbitrary BTQL/SQL, the model gateway, hosted prompts and functions, remote
                evaluation infrastructure, attachments and overflow objects, snapshot environments,
                and server-side baseline summaries.
              </p>
            </div>
          </div>
          <div className="migration-validation">
            <ShieldCheck size={17} />
            <p>
              This is compatibility with a tested workflow subset, not complete Braintrust API
              parity. Existing Braintrust project IDs must be replaced with MindTrust IDs. Use the
              selected project’s name below; a scoped editor key cannot create a new project.
            </p>
          </div>
        </div>
      </Section>
      <div className="integration-grid">
        <CodeSection
          title="1. Configure your application"
          detail="Set these in your application environment, replacing any previous Braintrust URLs, key, and organization name."
          code={environment}
        />
        <CodeSection
          title="2. Send a small verification trace"
          detail="Runs locally without a model provider. Confirm the root and child spans in MindTrust Logs."
          code={logger}
        />
      </div>
      <div className="integration-doc-link">
        <a
          className="text-link"
          href="https://github.com/PreMan-Inc/MindTrust/blob/main/docs/braintrust-compatibility.md"
          target="_blank"
          rel="noreferrer"
        >
          Read the versioned compatibility guide
          <ArrowRight size={13} />
        </a>
        <span>
          Project ID: <code>{projectId || 'No project selected'}</code>
        </span>
      </div>
    </>
  );
}
function DatasetMigration({ datasets, onClose }: { datasets: Dataset[]; onClose: () => void }) {
  const { projectId, refreshAll, notify } = useWorkspace();
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const action = useAction();
  return (
    <Modal
      title="Import a dataset export"
      description="Import a JSON array. Existing row IDs are updated; other examples are preserved in a new dataset version."
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={() =>
          action.run(async () => {
            const rows = parseJson(json, 'Dataset export');
            if (!Array.isArray(rows)) throw new Error('Expected a JSON array of dataset examples.');
            let id = target;
            if (target === 'new') {
              if (createdId) id = createdId;
              else {
                const dataset = await post<Dataset>('/datasets', {
                  projectId,
                  name,
                  description: 'Imported dataset export',
                });
                id = dataset.id;
                setCreatedId(id);
              }
            }
            const result = await post<DatasetDetail>(`/datasets/${encodeURIComponent(id)}/import`, {
              rows,
            });
            refreshAll();
            notify(
              `Imported ${rows.length} rows · ${result.dataset.name} v${result.dataset.version}`,
            );
            onClose();
          })
        }
      >
        <Field label="Destination">
          <select value={target} disabled={!!createdId} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">Create a new dataset</option>
            {datasets.map((d) => (
              <option value={d.id} key={d.id}>
                {d.name} · v{d.version}
              </option>
            ))}
          </select>
        </Field>
        {target === 'new' && (
          <Field label="Dataset name">
            <input
              required
              disabled={!!createdId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Imported support regressions"
            />
          </Field>
        )}
        <Field label="Choose a JSON export">
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                file
                  .text()
                  .then(setJson)
                  .catch((e) => action.setError(e.message));
            }}
          />
        </Field>
        <Field label="Dataset JSON">
          <textarea
            className="code-input extra-tall"
            required
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={'[\n  {"_id":"example-1","input":{"question":"Hello"},"expected":"Hi"}\n]'}
          />
        </Field>
        {createdId && (
          <div className="info-banner">
            The destination dataset was created. Fix the import error below and retry; another
            dataset will not be created.
          </div>
        )}
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Import dataset" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
