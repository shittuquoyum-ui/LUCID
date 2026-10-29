/**
 * The two model steps, each with one retry.
 *
 * Step 1 picks the concept; step 2 writes the lesson. Each answer must parse,
 * pass its schema and pass the quote checker. On failure the model gets ONE
 * more try with the exact problems listed; if that fails too, the PR gets no
 * lesson. No lesson beats a wrong one.
 *
 * The lesson is also run through the plain-English checker. Its problems join
 * the same single retry, but they never cost the lesson: a lesson whose quotes
 * are true and whose wording is still too technical is kept and marked.
 *
 * Once quotes and wording pass, a second model fact-checks the lesson against
 * the real BEFORE/AFTER difference (see review.ts). False claims join the same
 * retry; if they are still false after it, there is no lesson. A quiz the
 * story already answers is kept and marked, like plain-English failures.
 */
import { conceptById, conceptListForPrompt } from '../concepts';
import { isChange, type DiffFile, type DiffSource } from './diff';
import { fakeLesson, fakePick } from './fake';
import { parseWith } from './json';
import { LISTING_LEGEND, renderListing } from './listing';
import { callModel, emptyUsage, type Effort, type Provider, type Usage } from './model';
import { checkPlainEnglish, type PlainCheck } from './plainCheck';
import { prompt } from './prompts';
import { checkEvidence, checkLesson, NO_CHANGE_QUOTED, type CheckedLesson, type LessonCheck } from './quoteCheck';
import { reviewLesson, type ReviewCheck } from './review';
import { ConceptPickSchema, LessonSchema, type ConceptPick } from './schemas';


export interface Attempt {
  step: 'pick' | 'write' | 'review';
  provider: Provider;
  problems: string[];
}

/**
 * Reasoning effort for the writer: the first draft, then the retry.
 * LUCID_WRITE_EFFORT and LUCID_WRITE_RETRY_EFFORT override them.
 * On five known commits, run twice each (whole lesson, average): medium for
 * both took 50s; low for both 32s but gave 2 of 10 quizzes the story answers;
 * low then medium took 35s with 1 of 10. Every claim passed the fact check in
 * all three. The retry is the hard round (fixing a false claim), so it gets
 * the extra thought.
 */
export const WRITE_EFFORT: { first: Effort; retry: Effort } = { first: 'low', retry: 'medium' };

const effortFrom = (name: string, fallback: Effort): Effort => {
  const v = process.env[name]?.trim();
  return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' ? v : fallback;
};
const writeEffort = (retry: boolean): Effort =>
  retry ? effortFrom('LUCID_WRITE_RETRY_EFFORT', WRITE_EFFORT.retry) : effortFrom('LUCID_WRITE_EFFORT', WRITE_EFFORT.first);

const retryNote = (problems: string[]): string =>
  `\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and return the complete JSON again:\n${problems.map((p) => `- ${p}`).join('\n')}`;

const diffBlock = (files: DiffFile[], title: string | null): string =>
  [title ? `Change title: ${title}` : null, 'DIFF', LISTING_LEGEND, '', renderListing(files)].filter((x) => x !== null).join('\n');

// ---------------------------------------------------------------------------

export interface PickResult {
  pick: ConceptPick | null;
  attempts: Attempt[];
  usage: Usage;
}

export const pickConcept = async (files: DiffFile[], title: string | null, provider: Provider): Promise<PickResult> => {
  const system = prompt('pickConcept');
  const base = `CONCEPT LIST (choose one id)\n${conceptListForPrompt()}\n\n${diffBlock(files, title)}`;
  const attempts: Attempt[] = [];
  const usage = emptyUsage();
  let problems: string[] = [];

  for (let round = 0; round < 2; round += 1) {
    const text = await callModel(
      provider,
      { system, user: base + (problems.length ? retryNote(problems) : ''), effort: 'low', maxTokens: 4000, usage },
      () => JSON.stringify(fakePick(files)),
    );
    const parsed = parseWith(ConceptPickSchema, text);
    if (!parsed.ok) {
      problems = parsed.problems;
    } else if (!parsed.value.teach) {
      attempts.push({ step: 'pick', provider, problems: [] });
      return { pick: parsed.value, attempts, usage };
    } else if (parsed.value.concept === 'none') {
      problems = ['"teach" is true but "concept" is "none": pick a concept id from the list, or set "teach" to false.'];
    } else if (parsed.value.evidence.length === 0) {
      problems = ['"teach" is true but there is no evidence: quote the lines that show the concept.'];
    } else {
      const { failed, showsChange } = checkEvidence(parsed.value.evidence, files);
      if (failed.length < parsed.value.evidence.length && showsChange) {
        attempts.push({ step: 'pick', provider, problems: failed.map((f) => `evidence ${f.item.file}:${f.item.line} dropped (${f.reason})`) });
        const kept = parsed.value.evidence.filter((e) => !failed.some((f) => f.item === e));
        return { pick: { ...parsed.value, evidence: kept }, attempts, usage };
      }
      problems = failed.map((f) => `evidence in ${f.item.file} at line ${f.item.line}: ${f.reason}`);
      // True lines, but none of them changed: there is no new behaviour to teach from them.
      if (failed.length < parsed.value.evidence.length) problems.push(`evidence: ${NO_CHANGE_QUOTED}, or set "teach" to false`);
    }
    attempts.push({ step: 'pick', provider, problems });
  }
  return { pick: null, attempts, usage };
};

// ---------------------------------------------------------------------------

export interface LessonResult {
  lesson: CheckedLesson | null;
  check: LessonCheck | null;
  /** The plain-English result for the returned lesson; null when there is no lesson. */
  plain: PlainCheck | null;
  /** The last fact check; null when no lesson got that far. */
  review: ReviewCheck | null;
  attempts: Attempt[];
  /** Milliseconds spent in fact checks, so the report can show them apart from writing. */
  reviewMs: number;
  usage: { write: Usage; review: Usage };
}

export const writeLesson = async (
  files: DiffFile[],
  title: string | null,
  pick: ConceptPick,
  source: DiffSource | null,
  provider: Provider,
  /** Who fact-checks the lesson; a different model from the writer is best. */
  reviewProvider: Provider = provider,
  /** Told before each writer call and each fact check, e.g. for a progress display. */
  onStep?: (step: 'writing' | 'fact-checking') => void,
): Promise<LessonResult> => {
  const system = prompt('writeLesson');
  const concept = conceptById(pick.concept);
  const evidence = pick.evidence.map((e) => `- ${e.file} line ${e.line} (${e.status}): ${e.code.trim()}`).join('\n');
  const base = [
    `CONCEPT: ${pick.concept} (${concept?.name ?? pick.concept}). ${concept?.plain ?? ''}`,
    `WHY THIS CONCEPT: ${pick.why}`,
    `KEY LINES:\n${evidence}`,
    '',
    diffBlock(files, title),
  ].join('\n');

  const changedLines = files.flatMap((f) => f.lines.filter((l) => isChange(l) && !l.redacted).map((l) => l.text));
  const attempts: Attempt[] = [];
  let problems: string[] = [];
  let lastCheck: LessonCheck | null = null;
  let lastReview: ReviewCheck | null = null;
  let reviewMs = 0;
  const usage = { write: emptyUsage(), review: emptyUsage() };

  const factCheck = async (lesson: CheckedLesson): Promise<ReviewCheck> => {
    onStep?.('fact-checking');
    const started = performance.now();
    const result = await reviewLesson(files, title, lesson, reviewProvider, { usage: usage.review });
    reviewMs += performance.now() - started;
    attempts.push(...result.attempts);
    lastReview = result.review;
    return result.review;
  };
  const done = (lesson: CheckedLesson | null, check: LessonCheck | null, plain: PlainCheck | null): LessonResult => ({
    lesson,
    check,
    plain: lesson ? plain : null,
    review: lastReview,
    attempts,
    reviewMs: Math.round(reviewMs),
    usage,
  });

  for (let round = 0; round < 2; round += 1) {
    const lastRound = round === 1;
    onStep?.('writing');
    const text = await callModel(
      provider,
      { system, user: base + (problems.length ? retryNote(problems) : ''), effort: writeEffort(round > 0), maxTokens: 12000, usage: usage.write },
      () => JSON.stringify(fakeLesson(pick)),
    );
    const parsed = parseWith(LessonSchema, text);
    if (!parsed.ok) {
      problems = parsed.problems;
      attempts.push({ step: 'write', provider, problems });
      continue;
    }
    const check = checkLesson(parsed.value, files, source);
    lastCheck = check;
    const lesson: CheckedLesson = { ...parsed.value, quotes: check.verified };
    const plain = checkPlainEnglish(lesson, changedLines);
    const quoteNotes = check.failed.map((f) => `quote in ${f.item.file} at line ${f.item.line}: ${f.reason}`);
    const quotesOk = check.verified.some((q) => q.changes);
    if (check.verified.length === 0 && quoteNotes.length === 0) quoteNotes.push('no quote could be verified against the diff');
    if (check.verified.length > 0 && !quotesOk) quoteNotes.push(NO_CHANGE_QUOTED);
    const notes = [...quoteNotes, ...plain.problems];
    attempts.push({ step: 'write', provider, problems: notes });

    // Fact-check only a lesson that could be shown: true quotes, and plain
    // wording (or no retry left to fix the wording).
    if (!quotesOk || (!plain.passed && !lastRound)) {
      problems = notes;
      continue;
    }
    const review = await factCheck(lesson);
    if (review.passed) return done(lesson, check, plain);
    if (lastRound) return review.claimsTrue ? done(lesson, check, plain) : done(null, check, null);
    problems = [...notes, ...review.problems];
  }
  return done(null, lastCheck, null);
};
