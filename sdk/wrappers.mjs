// Provider client wrappers: each model call becomes an `llm` span, nested
// under whatever trace is current when the call is made.

const obj = (value) => (value && typeof value === 'object' ? value : {});
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const message = (error) => (error instanceof Error ? error.message : String(error));

/** Proxies `paths` (dot-separated, ending in a method) without touching the original client. */
function wrapPaths(target, wrappers, prefix = '') {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver);
      if (typeof key !== 'string') return value;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'function' && wrappers[path])
        return wrappers[path]((...args) => value.apply(object, args));
      if (
        value &&
        typeof value === 'object' &&
        Object.keys(wrappers).some((p) => p.startsWith(`${path}.`))
      )
        return wrapPaths(value, wrappers, path);
      return value;
    },
  });
}

function wrapStream(stream, span, aggregator, finished) {
  let closed = false;
  const close = (error) => {
    if (closed) return;
    closed = true;
    if (error) span.update({ status: 'error', output: { error: message(error) } });
    else span.update(aggregator.result());
    finished();
  };
  return new Proxy(stream, {
    get(object, key, receiver) {
      if (key !== Symbol.asyncIterator) return Reflect.get(object, key, receiver);
      return () => {
        const iterator = object[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const step = await iterator.next();
              if (step.done) close();
              else aggregator.add(step.value);
              return step;
            } catch (error) {
              close(error);
              throw error;
            }
          },
          async return(value) {
            close();
            return iterator.return ? iterator.return(value) : { done: true, value };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };
    },
  });
}

function traced(client, name, provider, call, record, aggregate) {
  return (...args) => {
    const params = obj(args[0]);
    const options = {
      kind: 'llm',
      input: params.messages ?? params.input ?? null,
      model: typeof params.model === 'string' ? params.model : undefined,
      metadata: {
        provider,
        ...(params.system !== undefined ? { system: params.system } : {}),
        ...(params.tools
          ? { tools: params.tools.map((t) => t?.function?.name ?? t?.name ?? null) }
          : {}),
      },
    };
    if (!params.stream)
      return client.trace(name, options, async (span) => {
        const response = await call(...args);
        span.update(record(response));
        return response;
      });
    // The span stays open until the caller finishes reading the stream.
    return new Promise((resolve, reject) => {
      client
        .trace(name, options, async (span) => {
          const stream = await call(...args);
          let finished;
          const done = new Promise((r) => (finished = r));
          resolve(wrapStream(stream, span, aggregate(), finished));
          await done;
        })
        .catch(reject);
    });
  };
}

const chatRecord = (response) => {
  const r = obj(response);
  const messages = (Array.isArray(r.choices) ? r.choices : []).map((c) => obj(c).message ?? null);
  return {
    output: messages.length === 1 ? messages[0] : messages,
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    inputTokens: count(obj(r.usage).prompt_tokens),
    outputTokens: count(obj(r.usage).completion_tokens),
  };
};
function chatAggregator() {
  const choices = new Map();
  let model, usage;
  return {
    add(chunk) {
      const c = obj(chunk);
      if (typeof c.model === 'string') model = c.model;
      if (c.usage) usage = obj(c.usage);
      for (const choice of Array.isArray(c.choices) ? c.choices : []) {
        const index = Number.isInteger(choice?.index) ? choice.index : 0;
        const acc = choices.get(index) ?? {
          role: 'assistant',
          content: null,
          tool_calls: new Map(),
        };
        choices.set(index, acc);
        const delta = obj(choice?.delta);
        if (typeof delta.role === 'string') acc.role = delta.role;
        if (typeof delta.content === 'string') acc.content = (acc.content ?? '') + delta.content;
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const at = Number.isInteger(call?.index) ? call.index : acc.tool_calls.size;
          const tool = acc.tool_calls.get(at) ?? {
            id: null,
            type: 'function',
            function: { name: '', arguments: '' },
          };
          acc.tool_calls.set(at, tool);
          if (typeof call.id === 'string') tool.id = call.id;
          if (typeof call.function?.name === 'string') tool.function.name += call.function.name;
          if (typeof call.function?.arguments === 'string')
            tool.function.arguments += call.function.arguments;
        }
      }
    },
    result() {
      const messages = [...choices.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, acc]) => ({
          role: acc.role,
          content: acc.content,
          ...(acc.tool_calls.size ? { tool_calls: [...acc.tool_calls.values()] } : {}),
        }));
      return {
        output: messages.length === 1 ? messages[0] : messages,
        ...(model ? { model } : {}),
        // OpenAI only reports streamed usage with stream_options.include_usage.
        inputTokens: count(usage?.prompt_tokens),
        outputTokens: count(usage?.completion_tokens),
      };
    },
  };
}

const responsesRecord = (response) => {
  const r = obj(response);
  return {
    output: typeof r.output_text === 'string' ? r.output_text : (r.output ?? null),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    inputTokens: count(obj(r.usage).input_tokens),
    outputTokens: count(obj(r.usage).output_tokens),
    ...(r.status === 'failed' ? { status: 'error' } : {}),
  };
};
function responsesAggregator() {
  let text = '',
    final = null;
  return {
    add(event) {
      const e = obj(event);
      if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') text += e.delta;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type))
        final = obj(e.response);
    },
    result() {
      return final
        ? { ...responsesRecord(final), output: final.output_text ?? text }
        : { output: text };
    },
  };
}

const anthropicRecord = (response) => {
  const r = obj(response);
  return {
    output: { role: r.role ?? 'assistant', content: r.content ?? null },
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    inputTokens: count(obj(r.usage).input_tokens),
    outputTokens: count(obj(r.usage).output_tokens),
  };
};
function anthropicAggregator() {
  const blocks = new Map();
  let model,
    inputTokens = 0,
    outputTokens = 0;
  return {
    add(event) {
      const e = obj(event);
      if (e.type === 'message_start') {
        const m = obj(e.message);
        if (typeof m.model === 'string') model = m.model;
        inputTokens = count(obj(m.usage).input_tokens);
        outputTokens = count(obj(m.usage).output_tokens);
      } else if (e.type === 'content_block_start') {
        blocks.set(e.index, { ...obj(e.content_block) });
      } else if (e.type === 'content_block_delta') {
        const block = blocks.get(e.index) ?? { type: 'text', text: '' };
        blocks.set(e.index, block);
        const delta = obj(e.delta);
        if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
        if (delta.type === 'input_json_delta')
          block.partial_json = (block.partial_json ?? '') + delta.partial_json;
      } else if (e.type === 'message_delta') {
        outputTokens = count(obj(e.usage).output_tokens) || outputTokens;
      }
    },
    result() {
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      return {
        output: { role: 'assistant', content },
        ...(model ? { model } : {}),
        inputTokens,
        outputTokens,
      };
    },
  };
}

/** Trace `chat.completions.create` and `responses.create` on an OpenAI client. */
export function wrapOpenAI(openai, client) {
  return wrapPaths(openai, {
    'chat.completions.create': (call) =>
      traced(client, 'openai.chat.completions', 'openai', call, chatRecord, chatAggregator),
    'responses.create': (call) =>
      traced(client, 'openai.responses', 'openai', call, responsesRecord, responsesAggregator),
  });
}

/** Trace `messages.create` on an Anthropic client. */
export function wrapAnthropic(anthropic, client) {
  return wrapPaths(anthropic, {
    'messages.create': (call) =>
      traced(client, 'anthropic.messages', 'anthropic', call, anthropicRecord, anthropicAggregator),
  });
}
