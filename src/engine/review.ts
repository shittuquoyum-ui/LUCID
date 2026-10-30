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
 *
 * Warning cards get the same treatment with their own questions: is the risk
 * really in the changed lines, is every consequence a possibility tied to
 * them, is the severity fair, is the fix prompt correct? A risk that depends
 * on code the change does not show is no warning: false alarms are worse
 * than silence.
 */
import { z } from 'zod';
import type { DiffFile } from './diff';
import { fakeReview, fakeWarningReview } from './fake';
import { parseWith } from './json';
import { LISTING_LEGEND, renderListing, renderVersions } from './listing';
import { callModel, type Effort, type Provider, type Usage } from './model';
import { prompt } from './prompts';
import type { CheckedLesson, CheckedRisk } from './quoteCheck';
import { SEVERITIES, type Severity } from './schemas';
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

/** The change as the reviewer reads it: BEFORE and AFTER, then the diff, then the card. */
const reviewInput = (files: DiffFile[], title: string | null, cardLabel: string, card: object): string =>
  [
    title ? `Change title: ${title}` : null,
    'THE CHANGE AS BEFORE AND AFTER',
    renderVersions(files),
    '',
    'THE SAME CHANGE AS A DIFF',
    LISTING_LEGEND,
    '',
    renderListing(files),
    '',
    cardLabel,
    JSON.stringify(card, null, 2),
  ]
    .filter((x) => x !== null)
    .join('\n');

/** Ask the reviewer, with one retry for an answer that does not parse. Null when it never does. */
const askReviewer = async <R, C extends { problems: string[] }>(
  schema: z.ZodType<R, z.ZodTypeDef, unknown>,
  toCheck: (r: R) => C,
  system: string,
  base: string,
  provider: Provider,
  options: ReviewOptions,
  fake: () => R,
): Promise<{ check: C | null; attempts: Attempt[] }> => {
  const effort = options.effort ?? reviewEffort();
  const attempts: Attempt[] = [];
  let problems: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const note = problems.length
      ? `\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and return the complete JSON again:\n${problems.map((p) => `- ${p}`).join('\n')}`
      : '';
    const text = await callModel(provider, { system, user: base + note, effort, maxTokens: 8000, usage: options.usage }, () => JSON.stringify(fake()));
    const parsed = parseWith(schema, text);
    if (parsed.ok) {
      const check = toCheck(parsed.value);
      attempts.push({ step: 'review', provider, problems: check.problems });
      return { check, attempts };
    }
    problems = parsed.problems;
    attempts.push({ step: 'review', provider, problems });
  }
  return { check: null, attempts };
};

const NO_VERDICT = 'fact check could not run: the checker never returned valid JSON';

export const reviewLesson = async (
  files: DiffFile[],
  title: string | null,
  lesson: CheckedLesson,
  provider: Provider,
  options: ReviewOptions = {},
): Promise<ReviewResult> => {
  const base = reviewInput(files, title, 'THE LESSON', lessonForReview(lesson));
  const { check, attempts } = await askReviewer(ReviewSchema, toReviewCheck, prompt('reviewLesson'), base, provider, options, fakeReview);
  return { review: check ?? { passed: false, claimsTrue: false, quizOk: false, problems: [NO_VERDICT] }, attempts };
};

// --- warning cards -------------------------------------------------------------

export const WarningReviewSchema = z.object({
  /** The risk is visible in the changed lines themselves, without guessing about code that is not shown. */
  riskShown: z.boolean(),
  wrongClaims: z.array(z.string().min(1).max(400)).max(8),
  /** The severity the reviewer would give. It replaces the picker's. */
  severity: z.enum(SEVERITIES),
  fixPromptOk: z.boolean(),
  fixProblem: z.string().max(400),
});

export type WarningReview = z.infer<typeof WarningReviewSchema>;

export interface WarningReviewCheck {
  passed: boolean;
  riskShown: boolean;
  /** Title, consequences, who is affected, plainWords and the idea match the change, as possibilities. */
  claimsTrue: boolean;
  fixOk: boolean;
  severity: Severity;
  problems: string[];
}

export const toWarningReviewCheck = (r: WarningReview): WarningReviewCheck => {
  const claimsTrue = r.wrongClaims.length === 0;
  const problems = [
    ...(r.riskShown ? [] : ['fact check: the risk is not shown in the changed lines themselves; it depends on code that is not in this change, so there is no warning']),
    ...r.wrongClaims.map((c) => `fact check found a false or unprovable claim: ${clause(c)}. Say only what the quoted lines could let happen`),
    ...(r.fixPromptOk ? [] : [`fact check: the fix prompt is wrong or unsafe${clause(r.fixProblem) ? ` (${clause(r.fixProblem)})` : ''}. Write a fix that is correct for this exact code`]),
  ];
  return { passed: r.riskShown && claimsTrue && r.fixPromptOk, riskShown: r.riskShown, claimsTrue, fixOk: r.fixPromptOk, severity: r.severity, problems };
};

export interface WarningReviewResult {
  review: WarningReviewCheck;
  attempts: Attempt[];
}

/** What the reviewer needs from the warning: every word the builder reads and the fix they would paste. */
const warningForReview = (warning: CheckedRisk, risk: { category: string; severity: Severity }) => ({
  category: risk.category,
  severity: risk.severity,
  title: warning.title,
  whatCouldHappen: warning.whatCouldHappen,
  whoIsAffected: warning.whoIsAffected,
  quotes: warning.quotes.map((q) => ({ file: q.file, line: q.line, code: q.code })),
  plainWords: warning.plainWords,
  fixPrompt: warning.fixPrompt,
  ideaBehindIt: warning.ideaBehindIt,
});

export const reviewWarning = async (
  files: DiffFile[],
  title: string | null,
  warning: CheckedRisk,
  risk: { category: string; severity: Severity },
  provider: Provider,
  options: ReviewOptions = {},
): Promise<WarningReviewResult> => {
  const base = reviewInput(files, title, 'THE WARNING', warningForReview(warning, risk));
  const { check, attempts } = await askReviewer(WarningReviewSchema, toWarningReviewCheck, prompt('reviewWarning'), base, provider, options, () =>
    fakeWarningReview(risk.severity),
  );
  return {
    review: check ?? { passed: false, riskShown: false, claimsTrue: false, fixOk: false, severity: risk.severity, problems: [NO_VERDICT] },
    attempts,
  };
};
