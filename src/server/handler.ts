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
import type { CardKind, LucidReport } from '../engine/lucid';
import type { ProveInput } from '../prover/prove';
import type { ProofResult } from '../prover/result';
import { prepareSetupFiles, SETUP_MAX_BYTES } from '../prover/setupFiles';
import { reportLines } from '../terminal';
import type { GitHubUser } from './github';
import type { DailyLimits } from './limits';

export const MAX_BODY_BYTES = 2_000_000;

export const LessonRequestSchema = z.object({
  /** The diff, already filtered on the builder's machine. The server filters it again. */
  diff: z.string().min(1).max(MAX_BODY_BYTES),
  title: z.string().max(300).nullish(),
  /**
   * The cards the extension can show and wants. Extensions before warning
   * cards send nothing and get lessons only; ['risk'] means lessons are off.
   */
  kinds: z.array(z.enum(['risk', 'lesson'])).min(1).max(2).optional(),
});

export interface ServerDeps {
  enabled: () => boolean;
  verify: (token: string) => Promise<GitHubUser | null>;
  limits: DailyLimits;
  runLesson: (input: { diffText: string; title: string | null; kinds: CardKind[] }) => Promise<LucidReport>;
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
    const report = await deps.runLesson({ diffText: input.diff, title: input.title ?? null, kinds: input.kinds ?? ['lesson'] });
    return { status: 200, body: { outcome: report.outcome, card: toCard(report), report: reportLines(report) } };
  } catch (err) {
    const e = err as { name?: string; status?: number };
    // Kind and status only: some services echo part of a key in their messages.
    return { status: 502, body: { error: 'model-error', kind: e?.name ?? 'Error', status: e?.status ?? null } };
  }
};

// --- POST /prove --------------------------------------------------------------------

/** Two versions of 1 MB of setup files each, plus JSON escaping. */
export const MAX_PROVE_BODY_BYTES = 2_600_000;

const SetupFileSchema = z.object({ path: z.string().min(1).max(300), text: z.string().max(SETUP_MAX_BYTES) });

export const ProveRequestSchema = z.object({
  before: z.array(SetupFileSchema).max(1000),
  after: z.array(SetupFileSchema).min(1).max(1000),
  touched: z.object({ tables: z.array(z.string().max(200)).max(50), policies: z.array(z.string().max(200)).max(100) }),
});

export interface ProveDeps {
  /** The prover's own switch (LUCID_PROVE_ENABLED); the server's switch counts too. */
  enabled: () => boolean;
  limits: DailyLimits;
  runProof: (input: ProveInput) => Promise<ProofResult>;
}

/**
 * The sandbox attack for a data-exposure warning. Same GitHub sign-in as
 * /lesson; 5 proofs per person per day and a global cap; only setup files,
 * which are filtered and masked again here, whatever the extension did.
 */
export const handleProve = async (authorization: string | undefined, rawBody: string, deps: ServerDeps, prove: ProveDeps): Promise<Reply> => {
  if (!deps.enabled() || !prove.enabled()) return { status: 503, body: { error: 'paused' } };

  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { status: 401, body: { error: 'sign-in-required' } };
  let user: GitHubUser | null;
  try {
    user = await deps.verify(token);
  } catch {
    return { status: 502, body: { error: 'github-unavailable' } };
  }
  if (!user) return { status: 401, body: { error: 'bad-token' } };

  let input: z.infer<typeof ProveRequestSchema>;
  try {
    const parsed = ProveRequestSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) return { status: 400, body: { error: 'bad-request' } };
    input = parsed.data;
  } catch {
    return { status: 400, body: { error: 'bad-request' } };
  }
  const before = prepareSetupFiles(input.before);
  const after = prepareSetupFiles(input.after);
  if (!before || !after) return { status: 413, body: { error: 'too-large' } };
  if (!after.length) return { status: 400, body: { error: 'bad-request' } };

  const limit = prove.limits.take(user.id);
  if (!limit.ok) return { status: 429, body: { error: limit.reason } };

  try {
    const result = await prove.runProof({ before, after, touched: input.touched });
    return { status: 200, body: { result } };
  } catch (err) {
    const e = err as { name?: string };
    return { status: 502, body: { error: 'prover-error', kind: e?.name ?? 'Error' } };
  }
};
