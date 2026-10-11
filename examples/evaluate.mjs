import { MindTrust, scorers } from '../sdk/index.mjs';

const baseUrl = process.env.MINDTRUST_URL || 'http://127.0.0.1:4310';
const apiKey = process.env.MINDTRUST_API_KEY;
const headers = {
  'content-type': 'application/json',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
};
const response = await fetch(`${baseUrl}/api/projects`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: `SDK example ${new Date().toISOString()}`,
    description: 'Synthetic local evaluation, no model calls.',
  }),
});
if (!response.ok) throw new Error(await response.text());
const project = await response.json();
const client = new MindTrust({ baseUrl, apiKey, projectId: project.id });
const dataset = await client.createDataset({
  name: 'Greeting regression',
  description: 'Synthetic examples to exercise the SDK; not an AI quality benchmark.',
  rows: [
    { input: { name: 'Ada' }, expected: 'Hello, Ada!' },
    { input: { name: 'Grace' }, expected: 'Hello, Grace!' },
    { input: { name: 'Linus' }, expected: 'Hello, Linus!' },
  ],
});
const experiment = await client.evaluate({
  name: 'greeting-v1',
  datasetId: dataset.id,
  concurrency: 2,
  trials: 2,
  task: async (input, { span }) =>
    span.trace('render-greeting', { kind: 'tool', input }, () => `Hello, ${input.name}!`),
  scorers: [scorers.exactMatch],
});
console.log(
  JSON.stringify(
    { projectId: project.id, experimentId: experiment.id, scores: experiment.scores },
    null,
    2,
  ),
);
