#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { GATE_EXIT_CODES, gate } from './index.mjs';

const USAGE = `Usage: mindtrust gate <experimentId> [options]

Exits 0 on pass, 1 on fail, 2 when the run is incomplete or not comparable
with its baseline, and 3 when no decision could be reached.

Options:
  --baseline <id>          Compare against this experiment
  --min-score <name=num>   Require a mean score of at least num (repeatable)
  --max-regressions <n>    Regressed rows tolerated against the baseline (default 0)
  --url <url>              Server URL (default $MINDTRUST_URL or http://127.0.0.1:4310)
  --json                   Print the full decision as JSON

The API key is read from $MINDTRUST_API_KEY.`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      baseline: { type: 'string' },
      'min-score': { type: 'string', multiple: true },
      'max-regressions': { type: 'string' },
      url: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, experimentId] = positionals;
  if (values.help || command !== 'gate' || !experimentId) {
    console.log(USAGE);
    return values.help ? 0 : 3;
  }
  const minScores = {};
  for (const item of values['min-score'] ?? []) {
    const at = item.lastIndexOf('=');
    const raw = item.slice(at + 1).trim();
    const floor = Number(raw);
    if (at < 1 || !raw || !Number.isFinite(floor))
      throw new Error(`--min-score expects name=number, got ${item}`);
    minScores[item.slice(0, at)] = floor;
  }
  const maxRegressions = Number(values['max-regressions'] ?? 0);
  if (!Number.isInteger(maxRegressions) || maxRegressions < 0)
    throw new Error('--max-regressions expects a non-negative integer');
  const result = await gate({
    baseUrl: values.url ?? process.env.MINDTRUST_URL ?? 'http://127.0.0.1:4310',
    apiKey: process.env.MINDTRUST_API_KEY,
    experimentId,
    baselineId: values.baseline,
    minScores,
    maxRegressions,
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.decision.toUpperCase()}  ${experimentId}`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    if (result.comparison)
      console.log(
        `  baseline ${result.comparison.baselineId}: ${result.comparison.regressions} regressed, ${result.comparison.improvements} improved`,
      );
  }
  return GATE_EXIT_CODES[result.decision] ?? 3;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mindtrust: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  },
);
