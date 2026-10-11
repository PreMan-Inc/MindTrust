import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSdkExperimentLink, uniqueNamedResource } from '../web/deep-links.ts';

test('official SDK experiment URL preserves encoded names and segment boundaries', () => {
  const path = '/app/MindTrust/p/QA%20%2F%20Agents/experiments/Run%20%231%20%E2%9C%93';
  assert.deepEqual(parseSdkExperimentLink(path), {
    kind: 'experiment',
    projectName: 'QA / Agents',
    experimentName: 'Run #1 ✓',
    path,
  });
});

test('unsupported and malformed SDK paths never resolve to a resource', () => {
  for (const path of [
    '/app/another-org/p/project/experiments/run',
    '/app/MindTrust/p/project/logs',
    '/app/MindTrust/p/project/experiments/run/extra',
    '/app/MindTrust/p/%E0%A4%A/experiments/run',
    '/app/MindTrust/p/project/experiments/%00',
  ])
    assert.equal(parseSdkExperimentLink(path).kind, 'invalid');
  assert.equal(parseSdkExperimentLink('/').kind, 'none');
});

test('resolution uses only accessible exact matches and rejects missing or ambiguous names', () => {
  const allowed = [{ id: 'allowed-project', name: 'Agent QA' }];
  assert.equal(uniqueNamedResource(allowed, 'Agent QA', 'project').id, 'allowed-project');
  assert.throws(() => uniqueNamedResource(allowed, 'Private project', 'project'), /not found or/);
  assert.throws(() => uniqueNamedResource(allowed, 'agent qa', 'project'), /not found or/);
  assert.throws(
    () =>
      uniqueNamedResource([...allowed, { id: 'another', name: 'Agent QA' }], 'Agent QA', 'project'),
    /More than one project/,
  );
  assert.throws(
    () => uniqueNamedResource([{ name: 'run' }, { name: 'run' }], 'run', 'experiment'),
    /More than one experiment/,
  );
});
