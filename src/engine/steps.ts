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
 */
import { readFileSync } from 'node:fs';
import { conceptById, conceptListForPrompt } from '../concepts';
import type { DiffFile, DiffSource } from './diff';
import { fakeLesson, fakePick } from './fake';
import { parseWith } from './json';
import { LISTING_LEGEND, renderListing } from './listing';
import { callModel, type Provider } from './model';
import { checkPlainEnglish, type PlainCheck } from './plainCheck';
import { checkEvidence, checkLesson, type CheckedLesson, type LessonCheck } from './quoteCheck';
import { ConceptPickSchema, LessonSchema, type ConceptPick } from './schemas';

const prompt = (name: string): string => readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');

export interface Attempt {
  step: 'pick' | 'write';
  provider: Provider;
  problems: string[];
}

const retryNote = (problems: string[]): string =>
  `\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and return the complete JSON again:\n${problems.map((p) => `- ${p}`).join('\n')}`;

const diffBlock = (files: DiffFile[], title: string | null): string =>
  [title ? `Change title: ${title}` : null, 'DIFF', LISTING_LEGEND, '', renderListing(files)].filter((x) => x !== null).join('\n');

// ---------------------------------------------------------------------------

export interface PickResult {
  pick: ConceptPick | null;
  attempts: Attempt[];
}

export const pickConcept = async (files: DiffFile[], title: string | null, provider: Provider): Promise<PickResult> => {
  const system = prompt('pickConcept');
  const base = `CONCEPT LIST (choose one id)\n${conceptListForPrompt()}\n\n${diffBlock(files, title)}`;
  const attempts: Attempt[] = [];
  let problems: string[] = [];

  for (let round = 0; round < 2; round += 1) {
    const text = await callModel(
      provider,
      { system, user: base + (problems.length ? retryNote(problems) : ''), effort: 'low', maxTokens: 4000 },
      () => JSON.stringify(fakePick(files)),
    );
    const parsed = parseWith(ConceptPickSchema, text);
    if (!parsed.ok) {
      problems = parsed.problems;
    } else if (!parsed.value.teach) {
      attempts.push({ step: 'pick', provider, problems: [] });
      return { pick: parsed.value, attempts };
    } else if (parsed.value.concept === 'none') {
      problems = ['"teach" is true but "concept" is "none": pick a concept id from the list, or set "teach" to false.'];
    } else if (parsed.value.evidence.length === 0) {
      problems = ['"teach" is true but there is no evidence: quote the lines that show the concept.'];
    } else {
      const failed = checkEvidence(parsed.value.evidence, files);
      if (failed.length < parsed.value.evidence.length) {
        attempts.push({ step: 'pick', provider, problems: failed.map((f) => `evidence ${f.item.file}:${f.item.line} dropped (${f.reason})`) });
        const kept = parsed.value.evidence.filter((e) => !failed.some((f) => f.item === e));
        return { pick: { ...parsed.value, evidence: kept }, attempts };
      }
      problems = failed.map((f) => `evidence in ${f.item.file} at line ${f.item.line}: ${f.reason}`);
    }
    attempts.push({ step: 'pick', provider, problems });
  }
  return { pick: null, attempts };
};

// ---------------------------------------------------------------------------

export interface LessonResult {
  lesson: CheckedLesson | null;
  check: LessonCheck | null;
  /** The plain-English result for the returned lesson; null when there is no lesson. */
  plain: PlainCheck | null;
  attempts: Attempt[];
}

export const writeLesson = async (
  files: DiffFile[],
  title: string | null,
  pick: ConceptPick,
  source: DiffSource | null,
  provider: Provider,
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

  const changedLines = files.flatMap((f) => f.lines.filter((l) => l.status !== 'unchanged' && !l.redacted).map((l) => l.text));
  const attempts: Attempt[] = [];
  let problems: string[] = [];
  let lastCheck: LessonCheck | null = null;

  for (let round = 0; round < 2; round += 1) {
    const lastRound = round === 1;
    const text = await callModel(
      provider,
      { system, user: base + (problems.length ? retryNote(problems) : ''), effort: 'medium', maxTokens: 12000 },
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
    const notes = [...check.failed.map((f) => `quote in ${f.item.file} at line ${f.item.line}: ${f.reason}`), ...plain.problems];
    attempts.push({ step: 'write', provider, problems: notes });
    if (check.verified.length > 0 && (plain.passed || lastRound)) {
      return { lesson, check, plain, attempts };
    }
    problems = notes.length ? notes : ['no quote could be verified against the diff'];
  }
  return { lesson: null, check: lastCheck, plain: null, attempts };
};
