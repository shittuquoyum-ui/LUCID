/**
 * Canned answers for the 'fake' provider, built from the real diff so the
 * rest of the pipeline (validation, quote checking, rendering) runs for real.
 * Fake lessons say so in their title; they are never mistaken for the product.
 */
import { changedCount, shownLine, type DiffFile, type DiffLine } from './diff';
import { HIDDEN_TEXT } from './filter';
import type { Review, WarningReview } from './review';
import type { ConceptPick, Lesson, Risk } from './schemas';
import type { RiskCategory, Signal } from './signals';

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

/** The fake picker trusts the first quotable risk signal; otherwise it guesses a lesson. Same shape as a real answer. */
export const fakePick = (files: DiffFile[], signals: Signal[] = []): object => {
  const risk = signals.find((s) => s.code !== HIDDEN_TEXT);
  if (risk) {
    return {
      kind: 'risk',
      concept: CONCEPT_FOR[risk.category],
      category: risk.category,
      why: `Fake model: trusted the "${risk.id}" signal.`,
      evidence: [{ file: risk.file, line: risk.line, status: risk.status, code: risk.code }],
    };
  }
  const spot = firstQuotable(files);
  if (!spot) return { kind: 'none', concept: 'none', why: 'Fake model: no added line worth quoting.', evidence: [] };
  const all = files.flatMap((f) => f.lines.filter((l) => l.status === 'added').map((l) => l.text)).join('\n');
  const concept = GUESSES.find(([re]) => re.test(all))?.[1] ?? 'error-handling';
  return {
    kind: 'lesson',
    concept,
    why: `Fake model: guessed "${concept}" from keywords in the added lines.`,
    evidence: [{ file: spot.file.path, line: shownLine(spot.line), status: 'added', code: spot.line.text }],
  };
};

const CONCEPT_FOR: Record<RiskCategory, string> = {
  'data-exposure': 'row-level-security',
  secrets: 'secrets-and-env',
  auth: 'authentication',
  ownership: 'authorization',
  payments: 'input-validation',
  other: 'api-routes',
};

/** The fake fact checker always passes; it never read anything. */
export const fakeReview = (): Review => ({ claimsTrue: true, wrongClaims: [], quizAnsweredByStory: false, quizProblem: '' });

/** The fake warning check passes too. */
export const fakeWarningReview = (): WarningReview => ({ riskShown: true, wrongClaims: [], severityReasonAccepted: true, fixPromptOk: true, fixProblem: '' });

/** Written to pass the plain-English checker, so fake runs exercise the happy path. */
export const fakeWarning = (pick: ConceptPick): Risk => {
  const first = pick.evidence[0]!;
  return {
    evidence: 'warning',
    title: '[fake model] A real warning would go here',
    whatCouldHappen: 'A real warning would say what this line could let happen.',
    whoIsAffected: 'The people a real warning would name.',
    quotes: [{ file: first.file, line: first.line, role: first.status === 'removed' ? 'removed' : 'shows', code: first.code, note: 'A real line from this change.' }],
    plainWords: 'A real warning would say what this line does in everyday words.',
    fixPrompt: `Look at ${first.file} line ${first.line} and explain what it does.`,
    ideaBehindIt: 'A real warning would teach the idea behind the risk. It would use one everyday comparison.',
  };
};

/** Written to pass the plain-English checker, so fake runs exercise the happy path. */
export const fakeLesson = (pick: ConceptPick): Lesson => {
  const first = pick.evidence[0]!;
  return {
    title: '[fake model] A real lesson would go here',
    story: [
      'This card came from the fake model, so the words are stand-ins.',
      'The line below is real. Lucid copied it from your change and checked it.',
    ],
    quotes: [{ file: first.file, line: first.line, role: 'shows', code: first.code, note: 'A real line from this change.' }],
    plainWords: 'A real lesson would say what this line does in everyday words.',
    question: 'You want a real lesson next time. What should you change?',
    options: { A: 'Set `LUCID_WRITE_PROVIDER` to `meta`', B: 'Nothing, this lesson is already real', C: 'Delete the line shown above' },
    answer: 'A',
    feedback: {
      A: 'Right. That tells Lucid to ask a real model.',
      B: 'Not quite. The fake model wrote these words.',
      C: 'Not quite. The line is real; only the words are stand-ins.',
    },
  };
};
