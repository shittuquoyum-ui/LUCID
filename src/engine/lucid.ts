/**
 * The whole agent for one change:
 *   diff -> filter -> pick concept -> write lesson -> verify quotes -> check plain English -> comment
 */
import { parseDiff, type DiffSource } from './diff';
import { filterDiff, type SkippedFile } from './filter';
import { modelName, providerFor, type Provider } from './model';
import type { PlainCheck } from './plainCheck';
import { renderComment } from './render';
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
  sentFiles: string[];
  skippedFiles: SkippedFile[];
  redactedLines: number;
  attempts: Attempt[];
  models: { pick: string; write: string };
}

export const runLucid = async (input: LucidInput): Promise<LucidReport> => {
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
    sentFiles: filtered.files.map((f) => f.path),
    skippedFiles: filtered.skipped,
    redactedLines: filtered.redacted,
    attempts: [],
    models: { pick: modelName(pickProvider), write: modelName(writeProvider) },
  };
  if (filtered.files.length === 0) return report;

  const picked = await pickConcept(filtered.files, input.title, pickProvider);
  report.attempts.push(...picked.attempts);
  report.pick = picked.pick;
  if (!picked.pick) return { ...report, outcome: 'pick-failed' };
  if (!picked.pick.teach) return { ...report, outcome: 'nothing-to-teach' };

  const written = await writeLesson(filtered.files, input.title, picked.pick, input.source, writeProvider);
  report.attempts.push(...written.attempts);
  report.check = written.check;
  report.plain = written.plain;
  if (!written.lesson) return { ...report, outcome: 'lesson-failed' };

  const { lesson } = written;
  const lessonId = `${input.source?.headSha.slice(0, 12) ?? 'local'}-${picked.pick.concept}`;
  return {
    ...report,
    outcome: 'lesson',
    lesson,
    comment: renderComment(lesson, { concept: picked.pick.concept, lessonId }),
  };
};
