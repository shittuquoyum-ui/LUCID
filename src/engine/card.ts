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
import { PROOF_STATEMENT, type ProofResult } from '../prover/result';
import type { Severity } from './schemas';
import { RULE_SEVERITY } from './severity';
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
  /** What the prover reproduced; only on a 'proven' card. */
  proof?: ProofView;
  /** The quiet line when the prover tried and could not reproduce it. */
  proofNote?: string;
}

export interface ProofView {
  /** The one statement every proof stands on. */
  statement: string;
  /** What happened, in plain words, with before and after. */
  sentence: string;
  query: string;
  table: string;
  role: 'anon' | 'bob';
  action: 'read' | 'update' | 'delete' | 'insert';
  rows: number;
  before: ProofResult['before'];
}

export type Card = LessonCard | WarningCard;

export const NOT_REPRODUCED_NOTE = "Lucid couldn't reproduce this in its sandbox. That doesn't mean it's safe.";

/** The line on a warning when the read worked but the data looks meant for everyone. */
export const publicNote = (table: string, role: ProofResult['role']): string =>
  `This change makes \`${table}\` readable by ${role === 'bob' ? 'anyone signed in' : 'anyone'}. If that's intended, you can ignore this.`;

const BEFORE_WORDS: Record<ProofResult['before'], string> = {
  blocked: 'blocked',
  leaked: 'also open',
  'no-table': "the table didn't exist",
  'not-run': 'not checked',
  error: 'not checked',
};

/** "In a disposable sandbox with fake users, a signed-out visitor read 2 of Alice's private rows from `notes`. Before your commit: blocked. After: leaked." */
export const proofSentence = (r: Pick<ProofResult, 'role' | 'action' | 'rows' | 'table' | 'before'>): string => {
  const who = r.role === 'anon' ? 'a signed-out visitor' : 'another signed-in user (Bob)';
  const whose = (kind: string) => (r.rows === 1 ? `Alice's ${kind}row` : `${r.rows} of Alice's ${kind}rows`);
  const added = r.rows === 1 ? 'a row' : `${r.rows} rows`;
  const did = { read: `read ${whose('private ')}`, update: `changed ${whose('')}`, delete: `deleted ${whose('')}`, insert: `added ${added} in Alice's name` }[r.action ?? 'read'];
  const after = r.action === 'read' ? 'leaked' : 'allowed';
  const where = r.action === 'update' || r.action === 'insert' ? 'in' : 'from';
  return `In a disposable sandbox with fake users, ${who} ${did} ${where} \`${r.table}\`. Before your commit: ${BEFORE_WORDS[r.before]}. After: ${after}.`;
};

/**
 * The card after the prover ran. Only this sets evidence to 'proven', and
 * only for a result the prover marked proven. Anything else leaves the
 * warning as it was, with one quiet line; it is never a safety claim.
 */
export const applyProof = (card: WarningCard, result: ProofResult): WarningCard => {
  if (result.status === 'proven' && result.table && result.role && result.action && result.query) {
    return {
      ...card,
      evidence: 'proven',
      proof: {
        statement: PROOF_STATEMENT,
        sentence: proofSentence(result),
        query: result.query,
        table: result.table,
        role: result.role,
        action: result.action,
        rows: result.rows,
        before: result.before,
      },
      proofNote: undefined,
    };
  }
  return { ...card, proofNote: result.publicRead && result.table ? publicNote(result.table, result.role) : NOT_REPRODUCED_NOTE };
};

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
      severity: report.severity ?? RULE_SEVERITY[pick.category ?? 'other'],
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
