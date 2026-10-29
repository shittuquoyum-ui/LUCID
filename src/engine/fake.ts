/**
 * Canned answers for the 'fake' provider, built from the real diff so the
 * rest of the pipeline (validation, quote checking, rendering) runs for real.
 * Fake lessons say so in their title; they are never mistaken for the product.
 */
import { conceptById } from '../concepts';
import { changedCount, shownLine, type DiffFile, type DiffLine } from './diff';
import type { ConceptPick, Lesson } from './schemas';

const GUESSES: [RegExp, string][] = [
  [/row level security|create policy|auth\.uid\(\)/i, 'row-level-security'],
  [/process\.env|import\.meta\.env|NEXT_PUBLIC_|VITE_/, 'secrets-and-env'],
  [/signIn|signUp|getSession|auth\./, 'authentication'],
  [/create table|alter table|migration/i, 'database-schema'],
  [/upsert|onConflict|unique/i, 'unique-keys-upserts'],
  [/\bz\.object|safeParse|validate/i, 'input-validation'],
  [/\bthrow\b|catch\s*\(|\berror\b/i, 'error-handling'],
  [/\bawait\b|\basync\b|Promise/, 'async-code'],
  [/useState|useEffect|store/, 'state-and-data-flow'],
];

/** The first changed line that is long enough to be worth quoting. */
const firstQuotable = (files: DiffFile[]): { file: DiffFile; line: DiffLine } | null => {
  const byChange = [...files].sort((a, b) => changedCount(b) - changedCount(a));
  for (const file of byChange) {
    const line = file.lines.find((l) => l.status === 'added' && !l.redacted && l.text.trim().length >= 8);
    if (line) return { file, line };
  }
  return null;
};

export const fakePick = (files: DiffFile[]): ConceptPick => {
  const spot = firstQuotable(files);
  if (!spot) return { teach: false, concept: 'none', why: 'Fake model: no added line worth quoting.', evidence: [] };
  const all = files.flatMap((f) => f.lines.filter((l) => l.status === 'added').map((l) => l.text)).join('\n');
  const concept = (GUESSES.find(([re]) => re.test(all))?.[1] ?? 'error-handling') as ConceptPick['concept'];
  return {
    teach: true,
    concept,
    why: `Fake model: guessed "${concept}" from keywords in the added lines.`,
    evidence: [{ file: spot.file.path, line: shownLine(spot.line), status: 'added', code: spot.line.text }],
  };
};

export const fakeLesson = (pick: ConceptPick): Lesson => {
  const first = pick.evidence[0]!;
  const name = conceptById(pick.concept)?.name ?? pick.concept;
  return {
    title: `[fake model] A lesson about ${name.toLowerCase()} would go here`,
    explanation:
      'This lesson was written by the fake provider, so the words are placeholders. ' +
      'The quote below is real: it was copied from the diff and verified by the quote checker. ' +
      'Set LUCID_WRITE_PROVIDER=meta to get a real lesson.',
    quotes: [{ file: first.file, line: first.line, role: 'shows', code: first.code, note: 'A real line from this change.' }],
    breaksIf: 'Placeholder: a real lesson says what goes wrong if this is done wrong.',
    question: 'Placeholder question: which provider wrote this lesson?',
    options: { A: 'Muse Spark 1.3', B: 'The fake provider', C: 'Muse Spark Open' },
    answer: 'B',
    answerWhy: 'LUCID_WRITE_PROVIDER is set to fake, so no model was called.',
  };
};
