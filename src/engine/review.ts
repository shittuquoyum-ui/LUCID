/**
 * The fact check: a second model reads the change as BEFORE and AFTER, then
 * judges the lesson against the real difference.
 *
 * The quote checker proves each quoted line exists; it cannot tell whether
 * the story about those lines is true. A rule that is dropped and created
 * again unchanged, or re-added in a new file, passes the quote checker but
 * does not change what the app does. This step catches that, and a quiz the
 * story already answers.
 *
 * Its answer is untrusted input like any other: it must parse and pass the
 * schema. An answer that never does counts as a failed check.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DiffFile } from './diff';
import { fakeReview } from './fake';
import { parseWith } from './json';
import { LISTING_LEGEND, renderListing, renderVersions } from './listing';
import { callModel, type Effort, type Provider, type Usage } from './model';
import type { CheckedLesson } from './quoteCheck';
import type { Attempt } from './steps';

export const ReviewSchema = z.object({
  claimsTrue: z.boolean(),
  wrongClaims: z.array(z.string().min(1).max(400)).max(8),
  quizAnsweredByStory: z.boolean(),
  quizProblem: z.string().max(400),
});

export type Review = z.infer<typeof ReviewSchema>;

export interface ReviewCheck {
  passed: boolean;
  /** Title, story, plainWords and the marked answer match the real change. */
  claimsTrue: boolean;
  /** The quiz is not already answered by the story. */
  quizOk: boolean;
  /** Retry notes for the writer. */
  problems: string[];
}

/** A sentence from the model, without its closing punctuation, so ours can follow. */
const clause = (s: string): string => s.trim().replace(/[.!?]+$/, '');

export const toReviewCheck = (r: Review): ReviewCheck => {
  // A "true" verdict that still lists wrong claims is not trusted.
  const claimsTrue = r.claimsTrue && r.wrongClaims.length === 0;
  const quizOk = !r.quizAnsweredByStory;
  const problems = [
    ...r.wrongClaims.map((c) => `fact check found a false claim: ${clause(c)}. Describe only what really behaves differently between BEFORE and AFTER`),
    ...(!claimsTrue && r.wrongClaims.length === 0 ? ['fact check: the lesson claims something the change does not do. Describe only what really behaves differently between BEFORE and AFTER'] : []),
    ...(quizOk ? [] : [`fact check: the story already answers the quiz${clause(r.quizProblem) ? ` (${clause(r.quizProblem)})` : ''}. Ask about a case the story does not cover`]),
  ];
  return { passed: claimsTrue && quizOk, claimsTrue, quizOk, problems };
};

const prompt = (): string => readFileSync(new URL('../prompts/reviewLesson.md', import.meta.url), 'utf8');

/** What the reviewer needs from the lesson: the words a reader sees, plus where the quotes are. */
const lessonForReview = (lesson: CheckedLesson) => ({
  title: lesson.title,
  story: lesson.story,
  plainWords: lesson.plainWords,
  quotes: lesson.quotes.map((q) => ({ file: q.file, line: q.line, code: q.code })),
  question: lesson.question,
  options: lesson.options,
  answer: lesson.answer,
  feedback: lesson.feedback,
});

export interface ReviewResult {
  review: ReviewCheck;
  attempts: Attempt[];
}

/**
 * Reasoning effort for the fact check; LUCID_REVIEW_EFFORT overrides it.
 * Baseten honours it (reasoning tokens roughly 0.5k low, 1.5k medium, 4k high).
 * On three lessons with known verdicts (a false claim, a giveaway quiz, a good
 * card), 'low' matched 'medium' and 'high' in every run at about half the time.
 */
export const REVIEW_EFFORT: Effort = 'low';

const reviewEffort = (): Effort => {
  const v = process.env.LUCID_REVIEW_EFFORT?.trim();
  return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' ? v : REVIEW_EFFORT;
};

export interface ReviewOptions {
  usage?: Usage;
  effort?: Effort;
}

export const reviewLesson = async (
  files: DiffFile[],
  title: string | null,
  lesson: CheckedLesson,
  provider: Provider,
  options: ReviewOptions = {},
): Promise<ReviewResult> => {
  const effort = options.effort ?? reviewEffort();
  const system = prompt();
  const base = [
    title ? `Change title: ${title}` : null,
    'THE CHANGE AS BEFORE AND AFTER',
    renderVersions(files),
    '',
    'THE SAME CHANGE AS A DIFF',
    LISTING_LEGEND,
    '',
    renderListing(files),
    '',
    'THE LESSON',
    JSON.stringify(lessonForReview(lesson), null, 2),
  ]
    .filter((x) => x !== null)
    .join('\n');

  const attempts: Attempt[] = [];
  let problems: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const note = problems.length
      ? `\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and return the complete JSON again:\n${problems.map((p) => `- ${p}`).join('\n')}`
      : '';
    const text = await callModel(
      provider,
      { system, user: base + note, effort, maxTokens: 8000, usage: options.usage },
      () => JSON.stringify(fakeReview()),
    );
    const parsed = parseWith(ReviewSchema, text);
    if (parsed.ok) {
      const review = toReviewCheck(parsed.value);
      attempts.push({ step: 'review', provider, problems: review.problems });
      return { review, attempts };
    }
    problems = parsed.problems;
    attempts.push({ step: 'review', provider, problems });
  }
  return {
    review: { passed: false, claimsTrue: false, quizOk: false, problems: ['fact check could not run: the checker never returned valid JSON'] },
    attempts,
  };
};
