/**
 * The card: everything the side panel (and the HTML preview) needs to show
 * one result, as plain JSON. Built from a finished report.
 *
 * Two kinds: a warning card for a risk the change shows, and a lesson card
 * for a change worth understanding. Both carry kind, category, severity and
 * evidence, so whoever shows them can tell them apart without guessing.
 */
import type { LucidReport } from './lucid';
import type { Letter } from './quickCheck';
import type { VerifiedQuote } from './quoteCheck';
import type { Severity } from './schemas';
import type { RiskCategory } from './signals';

export interface CardQuote {
  file: string;
  line: number;
  endLine: number;
  code: string;
  /** Permanent GitHub link to the lines, or null for local diffs. */
  link: string | null;
}

interface CardChecks {
  quotesVerified: number;
  quotesTotal: number;
  plainEnglish: 'passed' | 'failed';
  /** The fact check. A lesson's claims are always true; 'failed' means the story answers the quiz. A warning always passed. */
  review: 'passed' | 'failed';
  /** How long each step took, in milliseconds. */
  timeMs: { pick: number; write: number; review: number; total: number };
}

export interface LessonCard {
  kind: 'lesson';
  category: null;
  severity: null;
  evidence: null;
  title: string;
  story: string[];
  /** The line that does it, with an everyday reading of it. */
  keyLine: CardQuote & { plainWords: string };
  extraQuote?: CardQuote & { note: string; removed: boolean };
  question: string;
  options: Record<Letter, string>;
  answer: Letter;
  feedback: Record<Letter, string>;
  concept: string;
  checks: CardChecks;
}

export interface WarningCard {
  kind: 'risk';
  category: RiskCategory;
  severity: Severity;
  /**
   * How sure Lucid is. Always 'warning' for now: Lucid saw the risk in the
   * change. 'proven' is reserved for the sandbox prover, once it has really
   * shown the leak; no model can set it.
   */
  evidence: 'warning' | 'proven';
  title: string;
  whatCouldHappen: string;
  whoIsAffected: string;
  /** The line, with an everyday reading of it. */
  keyLine: CardQuote & { plainWords: string };
  extraQuote?: CardQuote & { note: string; removed: boolean };
  /** A ready-to-paste instruction for the builder's AI tool. */
  fixPrompt: string;
  ideaBehindIt: string;
  concept: string;
  checks: CardChecks;
}

export type Card = LessonCard | WarningCard;

const quote = (q: VerifiedQuote): CardQuote => ({ file: q.file, line: q.line, endLine: q.endLine, code: q.code, link: q.link });
const extraOf = (extra: VerifiedQuote | undefined) =>
  extra ? { extraQuote: { ...quote(extra), note: extra.note, removed: extra.role === 'removed' } } : {};

/** The card for a report, or null when the report has no lesson or warning. */
export const toCard = (report: LucidReport): Card | null => {
  const { lesson, warning, pick, check, plain, review, timing } = report;
  if (!pick) return null;

  const checks = (quotes: VerifiedQuote[], reviewPassed: boolean): CardChecks => {
    const verified = check?.verified.length ?? quotes.length;
    return {
      quotesVerified: verified,
      quotesTotal: verified + (check?.failed.length ?? 0),
      plainEnglish: plain?.passed ? 'passed' : 'failed',
      review: reviewPassed ? 'passed' : 'failed',
      // A card means every step ran, so every time is set.
      timeMs: { pick: timing.pickMs ?? 0, write: timing.writeMs ?? 0, review: timing.reviewMs ?? 0, total: timing.totalMs },
    };
  };

  if (report.outcome === 'warning' && warning) {
    const [key, extra] = warning.quotes;
    if (!key) return null;
    return {
      kind: 'risk',
      category: pick.category ?? 'other',
      severity: report.severity ?? pick.severity ?? 'medium',
      // Never taken from the model: a written warning is a warning.
      evidence: 'warning',
      title: warning.title,
      whatCouldHappen: warning.whatCouldHappen,
      whoIsAffected: warning.whoIsAffected,
      keyLine: { ...quote(key), plainWords: warning.plainWords },
      ...extraOf(extra),
      fixPrompt: warning.fixPrompt,
      ideaBehindIt: warning.ideaBehindIt,
      concept: pick.concept,
      checks: checks(warning.quotes, report.warningReview?.passed ?? false),
    };
  }

  if (!lesson) return null;
  const [key, extra] = lesson.quotes;
  if (!key) return null;
  return {
    kind: 'lesson',
    category: null,
    severity: null,
    evidence: null,
    title: lesson.title,
    story: lesson.story,
    keyLine: { ...quote(key), plainWords: lesson.plainWords },
    ...extraOf(extra),
    question: lesson.question,
    options: lesson.options,
    answer: lesson.answer,
    feedback: lesson.feedback,
    concept: pick.concept,
    checks: checks(lesson.quotes, review?.passed ?? false),
  };
};
