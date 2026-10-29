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

/** Step 2: the lesson itself, plus one quick check question. */
export const LessonSchema = z.object({
  title: z.string().min(1).max(120),
  explanation: z.string().min(1).max(1200),
  quotes: z.array(QuoteSchema).min(1).max(4),
  breaksIf: z.string().min(1).max(300),
  question: z.string().min(1).max(300),
  options: z.object({ A: z.string().min(1).max(200), B: z.string().min(1).max(200), C: z.string().min(1).max(200) }),
  answer: z.enum(['A', 'B', 'C']),
  answerWhy: z.string().min(1).max(300),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type ConceptPick = z.infer<typeof ConceptPickSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
