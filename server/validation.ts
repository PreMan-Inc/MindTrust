import { z } from 'zod';
import { HttpError } from './store.ts';
export const idSchema = z.string().trim().min(1).max(200);
export const jsonSchema = z.json();
export const metaSchema = z.record(z.string().max(200), jsonSchema);
export const nameSchema = z.string().trim().min(1).max(200);
const tags = z.array(z.string().max(100)).max(100);
const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dollars = z.number().finite().min(0).max(1e12).nullable();
const timestamp = z.string().datetime({ offset: true });
export const rowSchema = z.object({
  id: idSchema.optional(),
  _id: idSchema.optional(),
  input: jsonSchema,
  expected: jsonSchema.optional(),
  hasExpected: z.boolean().optional(),
  metadata: metaSchema.optional(),
  tags: tags.optional(),
});
export const scorerSchema = z.object({
  projectId: idSchema,
  name: nameSchema,
  type: z.enum(['exact_match', 'contains', 'json_valid']),
  config: metaSchema.optional(),
  description: z.string().max(10000).optional(),
});
export const taskSchema = z
  .object({
    type: z.enum(['echo', 'template', 'openai']),
    template: z.string().max(100000).optional(),
    system: z.string().max(100000).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(32768).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'template' && value.template === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Template task requires template',
        path: ['template'],
      });
  });
export const spanSchema = z.object({
  id: idSchema.optional(),
  traceId: idSchema.optional(),
  parentId: idSchema.nullable().optional(),
  name: nameSchema.optional(),
  kind: z.enum(['agent', 'llm', 'tool', 'retrieval', 'function']).optional(),
  status: z.enum(['ok', 'error']).optional(),
  startTime: timestamp.optional(),
  endTime: timestamp.optional(),
  input: jsonSchema.optional(),
  output: jsonSchema.optional(),
  metadata: metaSchema.optional(),
  model: z.string().max(200).nullable().optional(),
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  costUsd: dollars.optional(),
});
export const traceSchema = z.object({
  id: idSchema.optional(),
  name: nameSchema,
  startTime: timestamp.optional(),
  endTime: timestamp.optional(),
  input: jsonSchema.optional(),
  output: jsonSchema.optional(),
  status: z.enum(['ok', 'error']).optional(),
  tags: tags.optional(),
  metadata: metaSchema.optional(),
  model: z.string().max(200).nullable().optional(),
  costUsd: dollars.optional(),
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  spans: z.array(spanSchema).max(10000).optional(),
});
export const importCaseSchema = z.object({
  rowId: idSchema,
  trial: z.number().int().min(1).max(10).optional(),
  input: jsonSchema,
  expected: jsonSchema,
  output: jsonSchema,
  scores: z.record(z.string().min(1).max(200), z.number().finite().min(0).max(1).nullable()),
  scoreErrors: z.record(z.string().max(200), z.string().max(10000)).optional(),
  latencyMs: z.number().finite().min(0).optional(),
  costUsd: dollars.optional(),
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  traceId: idSchema.nullable().optional(),
  error: z.string().max(10000).nullable().optional(),
});
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .slice(0, 5)
        .join('; '),
    );
  return result.data;
}
export function positiveQuery(value: unknown, fallback: number, max = 100000) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(number) || number < 0 || number > max)
    throw new HttpError(400, 'Invalid numeric query parameter');
  return number;
}
