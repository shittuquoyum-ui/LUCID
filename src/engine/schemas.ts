/**
 * The exact shape each model step must return. Model output is untrusted
 * input, just like a request body: nothing reaches the builder until it
 * passes these schemas AND the quote checker.
 */
import { z } from 'zod';
import { CONCEPT_IDS } from '../concepts';

const status = z.enum(['added', 'removed', 'unchanged']);

/** A piece of diff the model points at: file + line + status + the exact code. */
export const EvidenceSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().positive(),
  status,
  code: z.string().min(1),
});

/** Step 1: is this change worth a lesson, and which concept does it show? */
export const ConceptPickSchema = z.object({
  teach: z.boolean(),
  concept: z.enum([...CONCEPT_IDS, 'none']),
  why: z.string().min(1).max(400),
  evidence: z.array(EvidenceSchema).max(4),
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

export type Evidence = z.infer<typeof EvidenceSchema>;
export type ConceptPick = z.infer<typeof ConceptPickSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
