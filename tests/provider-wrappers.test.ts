import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

const sdkModule = '../sdk/index.mjs';
const { MindTrust, wrapOpenAI, wrapAnthropic } = (await import(
  sdkModule
)) as typeof import('../sdk/index');

type JsonRecord = Record<string, any>;

async function collector() {
  const bodies: JsonRecord[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    bodies.push(raw ? JSON.parse(raw) : {});
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new MindTrust({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    projectId: 'project-1',
    apiKey: 'fixture-key',
  });
  return {
    client,
    traces: async () => {
      await client.flush();
      return bodies.flatMap((body) => body.traces || []) as JsonRecord[];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const llmSpans = (traces: JsonRecord[]) =>
  traces.flatMap((trace) => trace.spans).filter((span: JsonRecord) => span.kind === 'llm');

const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

async function* fromArray<T>(items: T[]) {
  for (const item of items) yield item;
}

function fakeOpenAI() {
  const calls: JsonRecord[] = [];
  const openai = {
    apiKey: 'sk-fixture',
    baseURL: 'https://example.invalid/v1',
    models: { list: async () => ({ data: [{ id: 'gpt-fixture' }] }) },
    chat: {
      completions: {
        create: async (request: JsonRecord): Promise<any> => {
          calls.push(request);
          if (request.fail) throw request.fail;
          if (request.stream)
            return fromArray([
              { model: 'gpt-fixture', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
              { model: 'gpt-fixture', choices: [{ delta: { content: 'lo' } }] },
              { model: 'gpt-fixture', choices: [{ delta: { content: ' world' } }] },
              {
                model: 'gpt-fixture',
                choices: [],
                usage: { prompt_tokens: 12, completion_tokens: 3 },
              },
            ]);
          return {
            id: 'chatcmpl-1',
            model: 'gpt-fixture-2026',
            choices: [{ message: { role: 'assistant', content: 'Paris' } }],
            usage: { prompt_tokens: 9, completion_tokens: 2 },
          };
        },
      },
    },
    responses: {
      create: async (request: JsonRecord) => {
        calls.push(request);
        return {
          id: 'resp-1',
          model: 'gpt-responses',
          output_text: 'Four',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Four' }] }],
          usage: { input_tokens: 7, output_tokens: 1 },
        };
      },
    },
  };
  return { openai, calls };
}

function fakeAnthropic() {
  const anthropic = {
    apiKey: 'ant-fixture',
    messages: {
      countTokens: async () => ({ input_tokens: 3 }),
      create: async (request: JsonRecord): Promise<any> => {
        if (request.fail) throw request.fail;
        if (request.stream)
          return fromArray([
            {
              type: 'message_start',
              message: { model: 'claude-fixture', usage: { input_tokens: 20, output_tokens: 1 } },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bon' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'jour' } },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 6 },
            },
            { type: 'message_stop' },
          ]);
        return {
          id: 'msg-1',
          model: 'claude-fixture',
          content: [{ type: 'text', text: 'Hola' }],
          usage: { input_tokens: 14, output_tokens: 4 },
        };
      },
    },
  };
  return { anthropic };
}

test('wrapOpenAI records chat and responses spans and leaves other properties alone', async (t) => {
  const sink = await collector();
  t.after(sink.close);
  const { openai, calls } = fakeOpenAI();
  const wrapped = wrapOpenAI(openai, sink.client);

  assert.equal(wrapped.apiKey, 'sk-fixture');
  assert.equal(wrapped.baseURL, 'https://example.invalid/v1');
  assert.deepEqual(await wrapped.models.list(), { data: [{ id: 'gpt-fixture' }] });

  const messages = [{ role: 'user', content: 'Capital of France?' }];
  const chat = await wrapped.chat.completions.create({ model: 'gpt-fixture', messages });
  assert.equal(chat.id, 'chatcmpl-1', 'the provider response is returned unchanged');
  const responses = await wrapped.responses.create({ model: 'gpt-responses', input: '2+2?' });
  assert.equal(responses.output_text, 'Four');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { model: 'gpt-fixture', messages });

  const traces = await sink.traces();
  assert.equal(traces.length, 2, 'outside a trace each call is its own root trace');
  const spans = llmSpans(traces);
  assert.equal(spans.length, 2);
  const chatSpan = spans.find((s) => s.name === 'openai.chat.completions')!;
  assert.ok(chatSpan);
  assert.equal(chatSpan.parentId ?? null, null);
  assert.deepEqual(chatSpan.input, messages);
  assert.equal(chatSpan.model, 'gpt-fixture-2026');
  assert.match(asText(chatSpan.output), /Paris/);
  assert.equal(chatSpan.inputTokens, 9);
  assert.equal(chatSpan.outputTokens, 2);
  assert.equal(chatSpan.status, 'ok');

  const responsesSpan = spans.find((s) => s.name === 'openai.responses')!;
  assert.ok(responsesSpan);
  assert.equal(responsesSpan.input, '2+2?');
  assert.equal(responsesSpan.model, 'gpt-responses');
  assert.match(asText(responsesSpan.output), /Four/);
  assert.equal(responsesSpan.inputTokens, 7);
  assert.equal(responsesSpan.outputTokens, 1);
});

test('wrapped calls nest under the current trace span', async (t) => {
  const sink = await collector();
  t.after(sink.close);
  const openai = wrapOpenAI(fakeOpenAI().openai, sink.client);
  const anthropic = wrapAnthropic(fakeAnthropic().anthropic, sink.client);

  await sink.client.trace('agent', async (root) => {
    await openai.chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'a' }],
    });
    await root.trace('tool step', { kind: 'tool' }, async () => {
      await anthropic.messages.create({
        model: 'c',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'b' }],
      });
    });
  });

  const traces = await sink.traces();
  assert.equal(traces.length, 1);
  const [trace] = traces;
  const byName = (name: string) => trace.spans.find((s: JsonRecord) => s.name === name);
  assert.equal(byName('openai.chat.completions').parentId, byName('agent').id);
  assert.equal(byName('anthropic.messages').parentId, byName('tool step').id);
  assert.ok(trace.spans.every((s: JsonRecord) => s.traceId === trace.id));
});

test('wrapAnthropic records model, output and usage, and passes other members through', async (t) => {
  const sink = await collector();
  t.after(sink.close);
  const raw = fakeAnthropic().anthropic;
  const anthropic = wrapAnthropic(raw, sink.client);
  assert.equal(anthropic.apiKey, 'ant-fixture');
  assert.deepEqual(await anthropic.messages.countTokens(), { input_tokens: 3 });

  const messages = [{ role: 'user', content: 'Say hi in Spanish' }];
  const reply = await anthropic.messages.create({
    model: 'claude-fixture',
    max_tokens: 20,
    messages,
  });
  assert.equal(reply.id, 'msg-1');

  const spans = llmSpans(await sink.traces());
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.name, 'anthropic.messages');
  assert.deepEqual(span.input, messages);
  assert.equal(span.model, 'claude-fixture');
  assert.match(asText(span.output), /Hola/);
  assert.equal(span.inputTokens, 14);
  assert.equal(span.outputTokens, 4);
});

test('streams finish their span only after the caller consumes them', async (t) => {
  const sink = await collector();
  t.after(sink.close);
  const openai = wrapOpenAI(fakeOpenAI().openai, sink.client);
  const anthropic = wrapAnthropic(fakeAnthropic().anthropic, sink.client);

  const chatStream = await openai.chat.completions.create({
    model: 'gpt-fixture',
    stream: true,
    messages: [{ role: 'user', content: 'greet' }],
  });
  assert.equal(typeof (chatStream as any)[Symbol.asyncIterator], 'function');
  assert.equal((await sink.traces()).length, 0, 'an unconsumed stream must not be recorded yet');

  const deltas: string[] = [];
  for await (const chunk of chatStream as AsyncIterable<JsonRecord>)
    deltas.push(chunk.choices[0]?.delta?.content ?? '');
  assert.equal(deltas.join(''), 'Hello world', 'the caller still sees every chunk');

  const anthropicStream = await anthropic.messages.create({
    model: 'claude-fixture',
    max_tokens: 20,
    stream: true,
    messages: [{ role: 'user', content: 'greet in French' }],
  });
  const events: string[] = [];
  for await (const event of anthropicStream as AsyncIterable<JsonRecord>) events.push(event.type);
  assert.equal(events.length, 7);

  const spans = llmSpans(await sink.traces());
  const chat = spans.find((s) => s.name === 'openai.chat.completions')!;
  assert.ok(chat);
  assert.match(asText(chat.output), /Hello world/);
  assert.equal(chat.model, 'gpt-fixture');
  assert.equal(chat.inputTokens, 12);
  assert.equal(chat.outputTokens, 3);
  assert.equal(chat.status, 'ok');
  assert.ok(chat.endTime);

  const claude = spans.find((s) => s.name === 'anthropic.messages')!;
  assert.ok(claude);
  assert.match(asText(claude.output), /Bonjour/);
  assert.equal(claude.model, 'claude-fixture');
  assert.equal(claude.inputTokens, 20);
  assert.equal(claude.outputTokens, 6);
  assert.ok(claude.endTime);
});

test('provider errors propagate unchanged and mark the span as an error', async (t) => {
  const sink = await collector();
  t.after(sink.close);
  const openai = wrapOpenAI(fakeOpenAI().openai, sink.client);
  const anthropic = wrapAnthropic(fakeAnthropic().anthropic, sink.client);
  const openaiError = Object.assign(new Error('rate limited'), { status: 429 });
  const anthropicError = Object.assign(new Error('overloaded'), { status: 529 });

  await assert.rejects(
    openai.chat.completions.create({ model: 'm', messages: [], fail: openaiError } as any),
    (error) => error === openaiError,
  );
  await assert.rejects(
    sink.client.trace('agent', async () =>
      anthropic.messages.create({
        model: 'c',
        max_tokens: 1,
        messages: [],
        fail: anthropicError,
      } as any),
    ),
    (error) => error === anthropicError,
  );

  const spans = llmSpans(await sink.traces());
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.equal(span.status, 'error', `${span.name} should be an error`);
    assert.ok(span.endTime);
  }
});
