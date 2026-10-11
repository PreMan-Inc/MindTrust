import { useState } from 'react';
import { ArrowRight, ArrowUpFromLine, Copy, KeyRound } from 'lucide-react';
import type { Dataset, DatasetDetail } from '../shared/types';
import { copy, parseJson, post, qs, useAction, useData, useWorkspace } from './lib';
import { usePermissions } from './session';
import { Button, ErrorBox, Field, Form, FormActions, Modal, PageHeader, Section } from './ui';

export function integrationBaseUrl() {
  return import.meta.env.DEV ? `${location.protocol}//${location.hostname}:4310` : location.origin;
}
export function IntegrationsPage() {
  const { projectId, project, refresh, navigate } = useWorkspace();
  const { canAdmin } = usePermissions();
  const [tab, setTab] = useState('agents');
  const [importing, setImporting] = useState(false);
  const datasets = useData<Dataset[]>(projectId ? `/datasets?${qs({ projectId })}` : null, refresh);
  const base = integrationBaseUrl();
  const curl = `export MINDTRUST_URL=${JSON.stringify(base)}\nexport MINDTRUST_API_KEY="<your-scoped-api-key>"\n\ncurl "$MINDTRUST_URL/api/traces" \\\n  -H "Authorization: Bearer $MINDTRUST_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  --data-binary @- <<'JSON'\n${JSON.stringify({ projectId: projectId || '<project-id>', traces: [{ name: 'my-agent', input: { message: 'Hello' }, output: { answer: 'Hello from MindTrust' }, status: 'ok', metadata: { source: 'integration-example', synthetic: true } }] }, null, 2)}\nJSON`;
  const native = `import { MindTrust } from "./sdk/index.mjs";\n\nconst client = new MindTrust({\n  baseUrl: ${JSON.stringify(base)},\n  projectId: ${JSON.stringify(projectId || '<project-id>')},\n  apiKey: process.env.MINDTRUST_API_KEY,\n});\n\nawait client.trace("support-agent", {\n  input: { message: "Hello" }, kind: "agent",\n}, async (span) => {\n  return "Agent response";\n});\nawait client.flush();`;
  const otlp = `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces\nOTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<your-key>,x-mindtrust-project-id=${encodeURIComponent(projectId || '<project-id>')}`;
  return (
    <>
      <PageHeader
        title="Integrations"
        actions={
          <>
            {canAdmin && (
              <Button onClick={() => navigate('settings')}>
                <KeyRound size={14} />
                API keys
              </Button>
            )}
            {tab === 'braintrust' && (
              <Button
                permission="write"
                variant="primary"
                disabled={!projectId}
                onClick={() => setImporting(true)}
              >
                <ArrowUpFromLine size={14} />
                Import dataset
              </Button>
            )}
          </>
        }
      />
      <div className="tabs settings-tabs" role="tablist" aria-label="Integration options">
        {[
          { id: 'agents', name: 'Agent evals' },
          { id: 'braintrust', name: 'Braintrust' },
          { id: 'native', name: 'SDK & API' },
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
      {tab === 'agents' && <AgentEvaluationSetup baseUrl={base} projectId={projectId || ''} />}
      {tab === 'braintrust' && (
        <BraintrustCompatibility baseUrl={base} projectName={project?.name || ''} />
      )}
      {tab === 'native' && (
        <Section title="Node.js SDK" detail="Use sdk/index.mjs from the MindTrust repository.">
          <div className="integration-section-body">
            <CodeSnippet code={native} label="SDK example" />
            <details className="compact-disclosure">
              <summary>HTTP request</summary>
              <p className="muted small-text">Send JSON traces with a scoped editor key.</p>
              <CodeSnippet code={curl} label="HTTP example" />
            </details>
          </div>
        </Section>
      )}
      {tab === 'otel' && (
        <Section title="OTLP/HTTP" detail="JSON only. Protobuf and gRPC are not supported.">
          <div className="integration-section-body">
            <CodeSnippet code={otlp} label="OTLP configuration" />
            <details className="compact-disclosure">
              <summary>Verify the connection</summary>
              <ol className="integration-steps">
                <li>Send a trace with a root and child span.</li>
                <li>Check parent IDs, timestamps, status and metrics in Logs.</li>
                <li>Costs stay unknown unless your application reports them.</li>
              </ol>
              <Button onClick={() => navigate('logs')} disabled={!projectId}>
                Open logs
                <ArrowRight size={14} />
              </Button>
            </details>
          </div>
        </Section>
      )}
      {importing && (
        <DatasetMigration datasets={datasets.data || []} onClose={() => setImporting(false)} />
      )}
    </>
  );
}
function AgentEvaluationSetup({ baseUrl, projectId }: { baseUrl: string; projectId: string }) {
  const { navigate } = useWorkspace();
  const example = `import { MindTrust, processTask } from './sdk/index.mjs';

const client = new MindTrust({
  baseUrl: ${JSON.stringify(baseUrl)},
  projectId: ${JSON.stringify(projectId || '<project-id>')},
  apiKey: process.env.MINDTRUST_API_KEY,
});

await client.evaluate({
  name: 'Agent regression',
  datasetId: '<dataset-id>',
  concurrency: 2,
  caseTimeoutMs: 120_000,
  task: processTask({
    command: 'python3', args: ['agent.py'],
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
  }),
  scorers: [{
    name: 'Expected outcome',
    score: ({ output, expected }) => Number(output.outcome === expected.outcome),
  }],
});`;
  return (
    <Section
      title="Run your agent"
      detail="Execute agent code in your environment. Inspect its results here."
    >
      <div className="integration-section-body">
        <p className="integration-paragraph">
          Evaluate JavaScript functions directly, or connect a Python agent with the process runner.
          Each case records tool calls, model usage, output and scores against a pinned dataset.
        </p>
        <CodeSnippet code={example} label="agent evaluation" />
        <details className="compact-disclosure">
          <summary>Python adapter contract</summary>
          <p className="muted small-text">
            Read one JSON request from stdin with input, metadata and trial. Return one JSON object
            on stdout with output and optional completed spans. Send diagnostics to stderr. Pass
            credentials explicitly; trusted local code runs with your operating system permissions.
          </p>
        </details>
        <details className="compact-disclosure">
          <summary>PreMan and public agent examples</summary>
          <p className="muted small-text">
            Repository examples cover PreMan’s shared agent loop, LangGraph, PydanticAI and
            smolagents. They use synthetic workspaces and real model calls. Provider access is
            required.
          </p>
          <a
            className="text-link"
            href="https://github.com/PreMan-Inc/MindTrust/blob/main/docs/agent-evaluations.md"
            target="_blank"
            rel="noreferrer"
          >
            Setup and execution guide <ArrowRight size={13} />
          </a>
        </details>
        <Button onClick={() => navigate('experiments')}>
          Open experiments <ArrowRight size={14} />
        </Button>
      </div>
    </Section>
  );
}
function CodeSnippet({ code, label }: { code: string; label: string }) {
  const { notify } = useWorkspace();
  const action = useAction();
  return (
    <div className="integration-snippet">
      <div className="integration-snippet-actions">
        <Button
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() =>
            action.run(async () => {
              await copy(code);
              notify('Copied');
            })
          }
        >
          <Copy size={13} />
          Copy
        </Button>
      </div>
      <ErrorBox message={action.error} />
      <pre className="sdk-snippet integration-code">{code}</pre>
    </div>
  );
}
function BraintrustCompatibility({
  baseUrl,
  projectName,
}: {
  baseUrl: string;
  projectName: string;
}) {
  const environment = `npm install braintrust@3.37.2\n\nexport BRAINTRUST_APP_URL=${JSON.stringify(baseUrl)}\nexport BRAINTRUST_API_URL=${JSON.stringify(baseUrl)}\nexport BRAINTRUST_API_KEY="<your-scoped-MindTrust-key>"\nexport BRAINTRUST_ORG_NAME="MindTrust"`;
  const logger = `import { initLogger, wrapTraced } from "braintrust";\n\nconst logger = initLogger({\n  projectName: ${JSON.stringify(projectName || '<existing-MindTrust-project-name>')},\n  asyncFlush: false,\n});\n\nconst normalize = wrapTraced(\n  async (input) => input.toUpperCase(),\n  { name: "normalize" },\n);\n\nawait logger.traced(async (span) => {\n  span.log({ input: "hello", metadata: { synthetic: true } });\n  const output = await normalize("hello");\n  span.log({ output });\n  return output;\n}, { name: "migration-smoke-check" });\n\nawait logger.flush();`;
  return (
    <Section title="Connect your SDK" detail="Tested with JavaScript 3.37.2 and Python 0.45.0.">
      <div className="integration-section-body">
        <p className="integration-paragraph">
          Traces, dataset versions and client-side evaluations. Use a MindTrust project and scoped
          API key.
        </p>
        <CodeSnippet code={environment} label="Braintrust configuration" />
        <details className="compact-disclosure">
          <summary>Send a verification trace</summary>
          <p className="muted small-text">
            This example runs locally without a model call. Check its root and child spans in Logs.
          </p>
          <CodeSnippet code={logger} label="verification trace" />
        </details>
        <details className="compact-disclosure">
          <summary>Compatibility limits</summary>
          <p className="muted small-text">
            This is a tested subset. Arbitrary BTQL/SQL, gateways, hosted prompts and functions,
            remote execution, attachments, overflow uploads and snapshot environments are
            unsupported. Explicit baseline summaries require the same dataset revision and full
            matching case coverage.
          </p>
          <p className="muted small-text">
            Replace Braintrust project IDs with MindTrust IDs. A scoped editor key needs an existing
            project. Compare outputs, scores and span trees before switching workloads.
          </p>
          <a
            className="text-link"
            href="https://github.com/PreMan-Inc/MindTrust/blob/main/docs/braintrust-compatibility.md"
            target="_blank"
            rel="noreferrer"
          >
            Compatibility guide
            <ArrowRight size={13} />
          </a>
        </details>
        <details className="compact-disclosure">
          <summary>Dataset import format</summary>
          <p className="muted small-text">
            Import a JSON array with input, expected output, metadata, tags and row IDs.{' '}
            <code>_id</code> is accepted when <code>id</code> is absent; omitted expectations stay
            distinct from JSON <code>null</code>.
          </p>
          <p className="muted small-text">
            Workspace permissions, attachments, saved queries, credentials and hosted functions are
            not imported. Verify row counts and sample outputs after import.
          </p>
        </details>
      </div>
    </Section>
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
      title="Import dataset"
      description="JSON array. Matching row IDs are updated; other rows remain. Each import creates a version."
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
              placeholder="e.g. Support regressions"
            />
          </Field>
        )}
        <Field label="JSON file">
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
            Dataset created. Fix the error and retry to use the same destination.
          </div>
        )}
        <ErrorBox message={action.error} />
        <FormActions busy={action.busy} label="Import dataset" onCancel={onClose} />
      </Form>
    </Modal>
  );
}
