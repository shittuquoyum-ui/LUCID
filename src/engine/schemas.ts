/**
 * The exact shape each model step must return. Model output is untrusted
 * input, just like a request body: nothing reaches the builder until it
 * passes these schemas AND the quote checker.
 */
import { z } from 'zod';
import { CONCEPT_IDS } from '../concepts';
import { RISK_CATEGORIES } from './signals';

const status = z.enum(['added', 'removed', 'unchanged']);

/** A piece of diff the model points at: file + line + status + the exact code. */
export const EvidenceSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().positive(),
  status,
  code: z.string().min(1),
});

export const PICK_KINDS = ['risk', 'lesson', 'none'] as const;
export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type PickKind = (typeof PICK_KINDS)[number];
export type Severity = (typeof SEVERITIES)[number];

/**
 * Step 1: does this change carry a risk, teach something, or neither? Which
 * concept does it show? A risk also gets a category and a severity.
 * `teach` (the older shape) still parses: true means a lesson. It always
 * comes out matching `kind`.
 */
export const ConceptPickSchema = z
  .object({
    kind: z.enum(PICK_KINDS).optional(),
    teach: z.boolean().optional(),
    concept: z.enum([...CONCEPT_IDS, 'none']),
    why: z.string().min(1).max(400),
    evidence: z.array(EvidenceSchema).max(4),
    category: z.enum(RISK_CATEGORIES).nullish(),
    /** Only when it differs from the rules' level for the category (see severity.ts), with a reason. */
    severity: z.enum(SEVERITIES).nullish(),
    severityReason: z.string().max(300).nullish(),
  })
  .transform((p) => {
    const kind: PickKind = p.kind ?? (p.teach ? 'lesson' : 'none');
    return { ...p, kind, teach: kind !== 'none', category: p.category ?? null, severity: p.severity ?? null, severityReason: p.severityReason ?? null };
  });

/**
 * A quote in the lesson. `role` says what the quote is used to show:
 *   'shows'   = how the app works NOW   -> must be added or unchanged lines
 *   'removed' = what this change took away -> must be removed lines
 */
export const QuoteSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().positive(),
  role: z.enum(['shows', 'removed']),
  code: z.string().min(1).max(600),
  note: z.string().min(1).max(300),
});

const perLetter = (max: number) =>
  z.object({ A: z.string().min(1).max(max), B: z.string().min(1).max(max), C: z.string().min(1).max(max) });

/**
 * Step 2: the lesson card. quotes[0] is "the line that does it".
 *
 * The schema only rejects answers too broken to show. The tighter targets
 * (title of 60 characters, 2 to 4 paragraphs of 3 sentences) are enforced by
 * the plain-English checker, so a slightly long title earns a retry note
 * instead of throwing the whole lesson away.
 */
export const LessonSchema = z.object({
  title: z.string().min(1).max(120),
  story: z.array(z.string().min(1).max(600)).min(2).max(6),
  quotes: z.array(QuoteSchema).min(1).max(2),
  plainWords: z.string().min(1).max(300),
  question: z.string().min(1).max(300),
  options: perLetter(200),
  answer: z.enum(['A', 'B', 'C']),
  feedback: perLetter(200),
});

/**
 * Step 2 for a risk: the warning card. quotes[0] is "the line".
 *
 * `evidence` says how sure Lucid is. Every warning a model writes is a
 * 'warning': the literal rejects anything else, so no model can ever mark a
 * risk 'proven'. Only the sandbox prover (not built yet) may set that, after
 * it has actually shown the leak.
 */
export const RiskSchema = z.object({
  evidence: z.literal('warning').default('warning'),
  title: z.string().min(1).max(120),
  whatCouldHappen: z.string().min(1).max(500),
  whoIsAffected: z.string().min(1).max(200),
  quotes: z.array(QuoteSchema).min(1).max(2),
  plainWords: z.string().min(1).max(300),
  fixPrompt: z.string().min(1).max(1200),
  ideaBehindIt: z.string().min(1).max(600),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ConceptPick = z.infer<typeof ConceptPickSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
