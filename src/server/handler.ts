/**
 * POST /lesson: a signed-in builder sends a filtered diff, the server runs
 * Lucid with its own model keys and answers with the lesson card.
 *
 * Order of checks: kill switch, sign-in, request shape, daily limits, then
 * the (paid) model calls. The server stores nothing: no diffs, no lessons,
 * no accounts. Only in-memory counters for the limits.
 */
import { z } from 'zod';
import { toCard } from '../engine/card';
import type { LucidReport } from '../engine/lucid';
import { reportLines } from '../terminal';
import type { GitHubUser } from './github';
import type { DailyLimits } from './limits';

export const MAX_BODY_BYTES = 2_000_000;

export const LessonRequestSchema = z.object({
  /** The diff, already filtered on the builder's machine. The server filters it again. */
  diff: z.string().min(1).max(MAX_BODY_BYTES),
  title: z.string().max(300).nullish(),
});

export interface ServerDeps {
  enabled: () => boolean;
  verify: (token: string) => Promise<GitHubUser | null>;
  limits: DailyLimits;
  runLesson: (input: { diffText: string; title: string | null }) => Promise<LucidReport>;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export const handleLesson = async (authorization: string | undefined, rawBody: string, deps: ServerDeps): Promise<Reply> => {
  if (!deps.enabled()) return { status: 503, body: { error: 'paused' } };

  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { status: 401, body: { error: 'sign-in-required' } };
  let user: GitHubUser | null;
  try {
    user = await deps.verify(token);
  } catch {
    return { status: 502, body: { error: 'github-unavailable' } };
  }
  if (!user) return { status: 401, body: { error: 'bad-token' } };

  let input: z.infer<typeof LessonRequestSchema>;
  try {
    const parsed = LessonRequestSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) return { status: 400, body: { error: 'bad-request' } };
    input = parsed.data;
  } catch {
    return { status: 400, body: { error: 'bad-request' } };
  }

  const limit = deps.limits.take(user.id);
  if (!limit.ok) return { status: 429, body: { error: limit.reason } };

  try {
    const report = await deps.runLesson({ diffText: input.diff, title: input.title ?? null });
    return { status: 200, body: { outcome: report.outcome, card: toCard(report), report: reportLines(report) } };
  } catch (err) {
    const e = err as { name?: string; status?: number };
    // Kind and status only: some services echo part of a key in their messages.
    return { status: 502, body: { error: 'model-error', kind: e?.name ?? 'Error', status: e?.status ?? null } };
  }
};
