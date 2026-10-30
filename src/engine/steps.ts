/**
 * The two model steps, each with one retry.
 *
 * Step 1 decides the kind (a risk, a lesson, or nothing) and picks the
 * concept; step 2 writes the warning card or the lesson (warnings: see
 * writeWarning). Each answer must parse,
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
import { fakeLesson, fakePick, fakeWarning } from './fake';
import { parseWith } from './json';
import { LISTING_LEGEND, renderListing } from './listing';
import { callModel, emptyUsage, type Effort, type Provider, type Usage } from './model';
import { checkPlainEnglish, checkPlainWarning, SAFETY_CLAIM, type PlainCheck } from './plainCheck';
import { prompt } from './prompts';
import { checkEvidence, checkLesson, checkQuotes, NO_CHANGE_QUOTED, type CheckedLesson, type CheckedRisk, type LessonCheck } from './quoteCheck';
import { reviewLesson, reviewWarning, type ReviewCheck, type WarningReviewCheck, type WarningRisk } from './review';
import { finalSeverity, proposeSeverity, type SeverityCall } from './severity';
import { ConceptPickSchema, LessonSchema, RiskSchema, type ConceptPick, type Risk, type Severity } from './schemas';
import { findSignals, recreatedNote, signalsForPrompt, type Signal } from './signals';


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
  [title ? `Change title: ${title}` : null, recreatedNote(files), 'DIFF', LISTING_LEGEND, '', renderListing(files)].filter((x) => x !== null).join('\n');

// ---------------------------------------------------------------------------

export interface PickResult {
  pick: ConceptPick | null;
  attempts: Attempt[];
  usage: Usage;
}

export const pickConcept = async (
  files: DiffFile[],
  title: string | null,
  provider: Provider,
  /** Pattern hints for the picker to confirm or reject. */
  signals: Signal[] = findSignals(files),
): Promise<PickResult> => {
  const system = prompt('pickConcept');
  const base = [
    `CONCEPT LIST (choose one id)\n${conceptListForPrompt()}`,
    `RISK HINTS (simple pattern checks on the changed lines: confirm or reject each one)\n${signalsForPrompt(signals)}`,
    diffBlock(files, title),
  ].join('\n\n');
  const attempts: Attempt[] = [];
  const usage = emptyUsage();
  let problems: string[] = [];

  for (let round = 0; round < 2; round += 1) {
    const text = await callModel(
      provider,
      { system, user: base + (problems.length ? retryNote(problems) : ''), effort: 'low', maxTokens: 4000, usage },
      () => JSON.stringify(fakePick(files, signals)),
    );
    const parsed = parseWith(ConceptPickSchema, text);
    if (!parsed.ok) {
      problems = parsed.problems;
    } else if (parsed.value.kind === 'none') {
      attempts.push({ step: 'pick', provider, problems: [] });
      return { pick: parsed.value, attempts, usage };
    } else if (parsed.value.concept === 'none') {
      problems = [`"kind" is "${parsed.value.kind}" but "concept" is "none": pick a concept id from the list, or set "kind" to "none".`];
    } else if (parsed.value.kind === 'risk' && !parsed.value.category) {
      problems = ['"kind" is "risk": give its "category" too.'];
    } else if (parsed.value.evidence.length === 0) {
      problems = [`"kind" is "${parsed.value.kind}" but there is no evidence: quote the lines that show it.`];
    } else {
      const { failed, showsChange } = checkEvidence(parsed.value.evidence, files);
      if (failed.length < parsed.value.evidence.length && showsChange) {
        attempts.push({ step: 'pick', provider, problems: failed.map((f) => `evidence ${f.item.file}:${f.item.line} dropped (${f.reason})`) });
        const kept = parsed.value.evidence.filter((e) => !failed.some((f) => f.item === e));
        return { pick: { ...parsed.value, evidence: kept }, attempts, usage };
      }
      problems = failed.map((f) => `evidence in ${f.item.file} at line ${f.item.line}: ${f.reason}`);
      // True lines, but none of them changed: there is no new behaviour to teach from them.
      if (failed.length < parsed.value.evidence.length) problems.push(`evidence: ${NO_CHANGE_QUOTED}, or set "kind" to "none"`);
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

// ---------------------------------------------------------------------------

export interface WarningResult {
  warning: CheckedRisk | null;
  /** The rules' severity, or the picker's one-level move when the fact checker accepted its reason. */
  severity: Severity;
  severityCall: SeverityCall;
  check: LessonCheck | null;
  plain: PlainCheck | null;
  review: WarningReviewCheck | null;
  attempts: Attempt[];
  reviewMs: number;
  usage: { write: Usage; review: Usage };
}

/** Words that call something safe, secure or proven, anywhere in the warning. */
const claimsSafety = (risk: Risk): boolean =>
  [risk.title, risk.whatCouldHappen, risk.whoIsAffected, risk.plainWords, risk.fixPrompt, risk.ideaBehindIt].some((t) => SAFETY_CLAIM.test(t));

/**
 * Step 2 for a risk: the warning card. Same single retry as a lesson, but
 * stricter at the end, because a false alarm is worse than silence: after
 * the retry, a warning the fact checker does not fully pass (risk not shown,
 * a wrong claim, a wrong fix) is dropped, and so is one that still calls
 * anything safe. Wording problems alone keep the warning, marked.
 */
export const writeWarning = async (
  files: DiffFile[],
  title: string | null,
  pick: ConceptPick,
  source: DiffSource | null,
  provider: Provider,
  reviewProvider: Provider = provider,
  onStep?: (step: 'writing' | 'fact-checking') => void,
): Promise<WarningResult> => {
  const system = prompt('writeWarning');
  const concept = conceptById(pick.concept);
  const category = pick.category ?? 'other';
  const risk: WarningRisk = { category, severity: proposeSeverity(category, pick.severity, pick.severityReason) };
  const evidence = pick.evidence.map((e) => `- ${e.file} line ${e.line} (${e.status}): ${e.code.trim()}`).join('\n');
  const base = [
    `RISK: ${risk.category}, severity ${risk.severity.proposed}`,
    `WHY: ${pick.why}`,
    `IDEA BEHIND IT: ${concept?.name ?? pick.concept}. ${concept?.plain ?? ''}`,
    `KEY LINES:\n${evidence}`,
    '',
    diffBlock(files, title),
  ].join('\n');

  const changedLines = files.flatMap((f) => f.lines.filter((l) => isChange(l) && !l.redacted).map((l) => l.text));
  const attempts: Attempt[] = [];
  let problems: string[] = [];
  let lastCheck: LessonCheck | null = null;
  let lastReview: WarningReviewCheck | null = null;
  let reviewMs = 0;
  const usage = { write: emptyUsage(), review: emptyUsage() };

  const done = (warning: CheckedRisk | null, check: LessonCheck | null, plain: PlainCheck | null): WarningResult => ({
    warning,
    severity: finalSeverity(risk.severity, lastReview?.severityReasonAccepted ?? false),
    severityCall: risk.severity,
    check,
    plain: warning ? plain : null,
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
      () => JSON.stringify(fakeWarning(pick)),
    );
    const parsed = parseWith(RiskSchema, text);
    if (!parsed.ok) {
      problems = parsed.problems;
      attempts.push({ step: 'write', provider, problems });
      continue;
    }
    const check = checkQuotes(parsed.value.quotes, files, source);
    lastCheck = check;
    const warning: CheckedRisk = { ...parsed.value, evidence: 'warning', quotes: check.verified };
    const plain = checkPlainWarning(warning, changedLines);
    const quoteNotes = check.failed.map((f) => `quote in ${f.item.file} at line ${f.item.line}: ${f.reason}`);
    const quotesOk = check.verified.some((q) => q.changes);
    if (check.verified.length === 0 && quoteNotes.length === 0) quoteNotes.push('no quote could be verified against the diff');
    if (check.verified.length > 0 && !quotesOk) quoteNotes.push(NO_CHANGE_QUOTED);
    const notes = [...quoteNotes, ...plain.problems];
    attempts.push({ step: 'write', provider, problems: notes });

    if (!quotesOk || (!plain.passed && !lastRound)) {
      problems = notes;
      continue;
    }
    if (claimsSafety(warning)) return done(null, check, null);

    onStep?.('fact-checking');
    const started = performance.now();
    const result = await reviewWarning(files, title, warning, risk, reviewProvider, { usage: usage.review });
    reviewMs += performance.now() - started;
    attempts.push(...result.attempts);
    lastReview = result.review;
    if (result.review.passed) return done(warning, check, plain);
    // The risk is not in the change: rewording cannot fix that.
    if (lastRound || !result.review.riskShown) return done(null, check, null);
    problems = [...notes, ...result.review.problems];
  }
  return done(null, lastCheck, null);
};
