import type { z } from 'zod';

/**
 * Pull the JSON object out of a model's answer. Models sometimes wrap it in
 * ```json fences or add a sentence before it; we take the outermost {...}.
 */
export const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('the answer contained no JSON object');
  return JSON.parse(body.slice(start, end + 1));
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** Parse and validate in one go, returning readable problems for a retry. */
export const parseWith = <T>(schema: z.ZodType<T>, text: string): Parsed<T> => {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, problems: [`Invalid JSON: ${(err as Error).message}`] };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    problems: result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
};
