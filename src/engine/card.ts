/**
 * The lesson card: everything the side panel (and the HTML preview) needs to
 * show one lesson, as plain JSON. Built from a finished report.
 */
import type { LucidReport } from './lucid';
import type { Letter } from './quickCheck';

export interface CardQuote {
  file: string;
  line: number;
  endLine: number;
  code: string;
  /** Permanent GitHub link to the lines, or null for local diffs. */
  link: string | null;
}

export interface LessonCard {
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
  checks: {
    quotesVerified: number;
    quotesTotal: number;
    plainEnglish: 'passed' | 'failed';
  };
}

/** The card for a report, or null when the report has no lesson. */
export const toCard = (report: LucidReport): LessonCard | null => {
  const { lesson, pick, check, plain } = report;
  if (!lesson || !pick) return null;
  const [key, extra] = lesson.quotes;
  if (!key) return null;

  const quote = (q: typeof key): CardQuote => ({ file: q.file, line: q.line, endLine: q.endLine, code: q.code, link: q.link });
  const verified = check?.verified.length ?? lesson.quotes.length;

  return {
    title: lesson.title,
    story: lesson.story,
    keyLine: { ...quote(key), plainWords: lesson.plainWords },
    ...(extra ? { extraQuote: { ...quote(extra), note: extra.note, removed: extra.role === 'removed' } } : {}),
    question: lesson.question,
    options: lesson.options,
    answer: lesson.answer,
    feedback: lesson.feedback,
    concept: pick.concept,
    checks: {
      quotesVerified: verified,
      quotesTotal: verified + (check?.failed.length ?? 0),
      plainEnglish: plain?.passed ? 'passed' : 'failed',
    },
  };
};
