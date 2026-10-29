/**
 * The whole agent for one change:
 *   diff -> filter -> pick concept -> write lesson -> verify quotes -> check plain English
 *     -> fact check (the pick provider) -> comment
 */
import { parseDiff, type DiffSource } from './diff';
import { filterDiff, type SkippedFile } from './filter';
import { modelName, providerFor, type Provider } from './model';
import type { PlainCheck } from './plainCheck';
import { renderComment } from './render';
import type { ReviewCheck } from './review';
import { pickConcept, writeLesson, type Attempt } from './steps';
import type { ConceptPick } from './schemas';
import type { CheckedLesson, LessonCheck } from './quoteCheck';

export interface LucidInput {
  diffText: string;
  source: DiffSource | null;
  title: string | null;
  providers?: { pick?: Provider; write?: Provider };
}

export interface LucidReport {
  /** 'lesson' = a comment is ready; otherwise why there is none. */
  outcome: 'lesson' | 'nothing-to-teach' | 'no-readable-files' | 'pick-failed' | 'lesson-failed';
  comment: string | null;
  lesson: CheckedLesson | null;
  pick: ConceptPick | null;
  check: LessonCheck | null;
  /** Kept lessons can still fail this; the card shows the result. */
  plain: PlainCheck | null;
  /** The fact check. A kept lesson always has true claims; its quiz may still be marked. */
  review: ReviewCheck | null;
  sentFiles: string[];
  skippedFiles: SkippedFile[];
  redactedLines: number;
  attempts: Attempt[];
  models: { pick: string; write: string };
  /** Milliseconds per step; null for a step that did not run. */
  timing: { pickMs: number | null; writeMs: number | null; reviewMs: number | null; totalMs: number };
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
    pick: null,
    check: null,
    plain: null,
    review: null,
    sentFiles: filtered.files.map((f) => f.path),
    skippedFiles: filtered.skipped,
    redactedLines: filtered.redacted,
    attempts: [],
    models: { pick: modelName(pickProvider), write: modelName(writeProvider) },
    timing: { pickMs: null, writeMs: null, reviewMs: null, totalMs: 0 },
  };
  const finish = (changes: Partial<LucidReport>): LucidReport => ({
    ...report,
    ...changes,
    timing: { ...report.timing, totalMs: since(started) },
  });
  if (filtered.files.length === 0) return finish({});

  const pickStarted = performance.now();
  const picked = await pickConcept(filtered.files, input.title, pickProvider);
  report.timing.pickMs = since(pickStarted);
  report.attempts.push(...picked.attempts);
  report.pick = picked.pick;
  if (!picked.pick) return finish({ outcome: 'pick-failed' });
  if (!picked.pick.teach) return finish({ outcome: 'nothing-to-teach' });

  const writeStarted = performance.now();
  // The pick provider fact-checks, so the writer never grades its own lesson.
  const written = await writeLesson(filtered.files, input.title, picked.pick, input.source, writeProvider, pickProvider);
  report.timing.writeMs = since(writeStarted) - written.reviewMs;
  report.timing.reviewMs = written.review ? written.reviewMs : null;
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
