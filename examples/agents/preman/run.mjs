import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MindTrust, processTask } from '../../../sdk/index.mjs';
import { premanScorers } from './scorers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const backend = process.env.PREMAN_BACKEND_DIR;
if (!backend) throw new Error('Set PREMAN_BACKEND_DIR to your authorized PreMan-Backend checkout');
const python = process.env.PREMAN_PYTHON || resolve(backend, '.venv/bin/python');
const baseUrl = process.env.MINDTRUST_URL || 'http://127.0.0.1:4310';
const apiKey = process.env.MINDTRUST_API_KEY;
const variant = process.argv.includes('--negative-control') ? 'corrupt-tool-result' : 'baseline';
const cases = JSON.parse(await readFile(resolve(here, 'cases.json'), 'utf8'));
const caseIndex = process.argv.indexOf('--case');
const caseId = caseIndex === -1 ? null : process.argv[caseIndex + 1];
if (caseIndex !== -1 && !cases.some((item) => item.id === caseId))
  throw new Error('Unknown --case ID');
const selected = caseId
  ? cases.filter((item) => item.id === caseId)
  : variant === 'baseline'
    ? cases
    : cases.slice(0, 1);
const workspace = JSON.parse(await readFile(resolve(here, 'workspace.json'), 'utf8'));
const env = Object.fromEntries(
  [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'PREMAN_ENV_FILE',
    'PREMAN_EVAL_PROVIDER',
    'PREMAN_EVAL_MODEL',
  ]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
env.PREMAN_BACKEND_DIR = resolve(backend);
env.PREMAN_EVAL_VARIANT = variant;
const runId = randomUUID();
const outputDirectory = resolve(repository, 'test-results/preman');
await mkdir(outputDirectory, { recursive: true });
const bootstrap = new MindTrust({ baseUrl, apiKey, projectId: 'bootstrap' });
const projects = await bootstrap.request('/projects');
const project =
  projects.find((item) => item.name === 'PreMan agent · live evaluation') ||
  (await bootstrap.request('/projects', {
    name: 'PreMan agent · live evaluation',
    description:
      'Actual PreMan shared production tool loop, live model calls, synthetic read-only workspace. Not an authenticated desktop evaluation.',
  }));
const client = new MindTrust({ baseUrl, apiKey, projectId: project.id });
const rows = selected.map(({ id, prompt, expected }) => ({
  id,
  input: { caseId: id, prompt, workspace },
  expected,
  metadata: { source: 'synthetic', variant },
}));
let dataset;
if (process.env.MINDTRUST_DATASET_ID) {
  const existing = await client.getDataset(process.env.MINDTRUST_DATASET_ID);
  if (
    existing.dataset.projectId !== project.id ||
    existing.rows.length !== rows.length ||
    !rows.every((row) =>
      existing.rows.some(
        (saved) =>
          saved.id === row.id &&
          JSON.stringify(saved.input) === JSON.stringify(row.input) &&
          JSON.stringify(saved.expected) === JSON.stringify(row.expected),
      ),
    )
  )
    throw new Error('Pinned dataset does not match this selected synthetic suite');
  dataset = existing.dataset;
} else
  dataset = await client.createDataset({
    name: `PreMan ${variant} ${runId.slice(0, 8)}`,
    description:
      variant === 'baseline'
        ? 'Read-only endpoint inventory, setup and mutation permissions.'
        : 'Intentional corruption of endpoint tool evidence; scores should fall.',
    rows,
  });
const experiment = await client.evaluate({
  name: `PreMan ${variant} · production round bound · ${new Date().toISOString()}`,
  description:
    'Real provider calls through the private production shared loop with its standard four-tool-round bound (five model turns). Only workspace storage is synthetic; no private implementation or system prompt is uploaded.',
  datasetId: dataset.id,
  datasetVersion: dataset.version,
  runId,
  task: processTask({
    command: python,
    args: [resolve(here, 'adapter.py')],
    cwd: repository,
    env,
    timeoutMs: 185_000,
  }),
  concurrency: 1,
  caseTimeoutMs: 190_000,
  scorers: premanScorers,
  onCheckpoint: (payload) =>
    writeFile(
      resolve(outputDirectory, `${runId}.checkpoint.json`),
      JSON.stringify(payload, null, 2),
    ),
});
const summary = {
  projectId: project.id,
  experimentId: experiment.id,
  variant,
  caseIds: selected.map((item) => item.id),
  scores: experiment.scores,
  runId,
};
await writeFile(
  resolve(outputDirectory, `${variant}.summary.json`),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
