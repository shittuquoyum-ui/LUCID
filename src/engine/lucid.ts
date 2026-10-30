/**
 * The whole agent for one change:
 *   diff -> filter -> risk signals -> pick (risk, lesson or nothing)
 *     -> write the warning or the lesson -> verify quotes -> check plain English
 *     -> fact check (the pick provider) -> card
 * A risk always beats a lesson: the picker is told so, and gets the signals.
 */
import { parseDiff, type DiffSource } from './diff';
import { filterDiff, type SkippedFile } from './filter';
import { modelName, providerFor, type Provider, type Usage } from './model';
import type { PlainCheck } from './plainCheck';
import { renderComment } from './render';
import type { ReviewCheck, WarningReviewCheck } from './review';
import { findSignals, type Signal } from './signals';
import { pickConcept, writeLesson, writeWarning, type Attempt } from './steps';
import type { ConceptPick, Severity } from './schemas';
import type { SeverityCall } from './severity';
import type { CheckedLesson, CheckedRisk, LessonCheck } from './quoteCheck';

export type CardKind = 'risk' | 'lesson';

export interface LucidInput {
  diffText: string;
  source: DiffSource | null;
  title: string | null;
  providers?: { pick?: Provider; write?: Provider };
  /** Which cards to write (default both). Without 'lesson', a lesson pick stops before the writer. */
  kinds?: CardKind[];
  /** Told when each step starts, e.g. for a progress display. */
  onStep?: (step: LucidStep) => void;
}

export type LucidStep = 'picking' | 'writing' | 'fact-checking';

export interface LucidReport {
  /** 'lesson' or 'warning' = a card is ready; otherwise why there is none. */
  outcome: 'lesson' | 'warning' | 'nothing-to-teach' | 'no-readable-files' | 'pick-failed' | 'lesson-failed' | 'warning-failed' | 'not-wanted';
  comment: string | null;
  lesson: CheckedLesson | null;
  /** The warning card's content; only when the outcome is 'warning'. */
  warning: CheckedRisk | null;
  /** The warning's severity: the rules', or the picker's one-level move when the fact checker accepted its reason. */
  severity: Severity | null;
  /** How the severity was decided. */
  severityCall: SeverityCall | null;
  pick: ConceptPick | null;
  /** What the pattern checks saw, before the picker. */
  signals: Signal[];
  check: LessonCheck | null;
  /** Kept lessons can still fail this; the card shows the result. */
  plain: PlainCheck | null;
  /** The fact check. A kept lesson always has true claims; its quiz may still be marked. */
  review: ReviewCheck | null;
  /** The fact check of a warning. A kept warning always passed it. */
  warningReview: WarningReviewCheck | null;
  sentFiles: string[];
  skippedFiles: SkippedFile[];
  redactedLines: number;
  attempts: Attempt[];
  models: { pick: string; write: string };
  /** Milliseconds per step; null for a step that did not run. */
  timing: { pickMs: number | null; writeMs: number | null; reviewMs: number | null; totalMs: number };
  /** Tokens per step, from the API responses; null for a step that did not run. */
  usage: { pick: Usage | null; write: Usage | null; review: Usage | null };
}

const since = (start: number): number => Math.round(performance.now() - start);

export const runLucid = async (input: LucidInput): Promise<LucidReport> => {
  const started = performance.now();
  const pickProvider = input.providers?.pick ?? providerFor('pick');
  const writeProvider = input.providers?.write ?? providerFor('write');
  const filtered = filterDiff(parseDiff(input.diffText));

  const report: LucidReport = {
    outcome: 'no-readable-files',
    comment: null,
    lesson: null,
    warning: null,
    severity: null,
    severityCall: null,
    pick: null,
    signals: [],
    check: null,
    plain: null,
    review: null,
    warningReview: null,
    sentFiles: filtered.files.map((f) => f.path),
    skippedFiles: filtered.skipped,
    redactedLines: filtered.redacted,
    attempts: [],
    models: { pick: modelName(pickProvider), write: modelName(writeProvider) },
    timing: { pickMs: null, writeMs: null, reviewMs: null, totalMs: 0 },
    usage: { pick: null, write: null, review: null },
  };
  const finish = (changes: Partial<LucidReport>): LucidReport => ({
    ...report,
    ...changes,
    timing: { ...report.timing, totalMs: since(started) },
  });
  if (filtered.files.length === 0) return finish({});

  report.signals = findSignals(filtered.files);
  input.onStep?.('picking');
  const pickStarted = performance.now();
  const picked = await pickConcept(filtered.files, input.title, pickProvider, report.signals);
  report.timing.pickMs = since(pickStarted);
  report.usage.pick = picked.usage;
  report.attempts.push(...picked.attempts);
  report.pick = picked.pick;
  if (!picked.pick) return finish({ outcome: 'pick-failed' });
  if (picked.pick.kind === 'none') return finish({ outcome: 'nothing-to-teach' });

  // A kind the caller cannot show (an older extension, or lessons turned off) is not written at all.
  if (!(input.kinds ?? ['risk', 'lesson']).includes(picked.pick.kind)) return finish({ outcome: 'not-wanted' });

  const writeStarted = performance.now();
  if (picked.pick.kind === 'risk') {
    // The pick provider fact-checks here too.
    const written = await writeWarning(filtered.files, input.title, picked.pick, input.source, writeProvider, pickProvider, input.onStep);
    report.timing.writeMs = since(writeStarted) - written.reviewMs;
    report.timing.reviewMs = written.review ? written.reviewMs : null;
    report.usage.write = written.usage.write;
    report.usage.review = written.review ? written.usage.review : null;
    report.attempts.push(...written.attempts);
    report.check = written.check;
    report.plain = written.plain;
    report.warningReview = written.review;
    report.severity = written.severity;
    report.severityCall = written.severityCall;
    if (!written.warning) return finish({ outcome: 'warning-failed' });
    return finish({ outcome: 'warning', warning: written.warning });
  }

  // The pick provider fact-checks, so the writer never grades its own lesson.
  const written = await writeLesson(filtered.files, input.title, picked.pick, input.source, writeProvider, pickProvider, input.onStep);
  report.timing.writeMs = since(writeStarted) - written.reviewMs;
  report.timing.reviewMs = written.review ? written.reviewMs : null;
  report.usage.write = written.usage.write;
  report.usage.review = written.review ? written.usage.review : null;
  report.attempts.push(...written.attempts);
  report.check = written.check;
  report.plain = written.plain;
  report.review = written.review;
  if (!written.lesson) return finish({ outcome: 'lesson-failed' });

  const { lesson } = written;
  const lessonId = `${input.source?.headSha.slice(0, 12) ?? 'local'}-${picked.pick.concept}`;
  return finish({
    outcome: 'lesson',
    lesson,
    comment: renderComment(lesson, { concept: picked.pick.concept, lessonId }),
  });
};
