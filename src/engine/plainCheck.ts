/**
 * The plain-English checker: Lucid's readability layer.
 *
 * Our readers build apps with AI and have never read code. Every word they
 * see (title, story, plainWords, question, options, feedback) is checked for
 * developer words, code names, long sentences and a quiz that gives itself
 * away. Plain code, no model call.
 *
 * Two kinds of text are exempt:
 *   - anything inside `backticks`, where the lesson shows code on purpose
 *   - words the app itself shows on screen, i.e. text inside quotes in the
 *     quoted code ('Validation failed' is what people see, not jargon)
 */
import type { Lesson } from './schemas';

export const TITLE_MAX = 60;
export const SENTENCE_MAX_WORDS = 20;
export const STORY_MAX_PARAGRAPHS = 4;
export const PARAGRAPH_MAX_SENTENCES = 3;

export const JARGON = [
  'function', 'variable', 'object', 'array', 'string', 'boolean', 'null', 'undefined', 'async', 'await',
  'promise', 'callback', 'API', 'endpoint', 'schema', 'query', 'component', 'props', 'state', 'hook',
  'render', 'middleware', 'validation', 'exception', 'error handling', 'parse', 'instance', 'class',
  'method', 'type', 'interface', 'runtime',
];

/** Product names that happen to look like code names. */
const BRAND_NAMES = new Set(['GitHub', 'iPhone', 'iPad', 'YouTube', 'PayPal', 'LinkedIn', 'WhatsApp', 'WordPress']);

export interface PlainCheck {
  passed: boolean;
  problems: string[];
}

const jargonPatterns = JARGON.map((word) => ({ re: new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i') }));
const IDENTIFIER = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g;
const NAMING = /\b(?:that['’]?s|that is|this is) called\b/i;
const PLACEHOLDER = '`…`';

/** Text inside quotes in the quoted code: words the app shows to its users. */
const appText = (lesson: Lesson): string[] => {
  const code = lesson.quotes.map((q) => q.code).join('\n');
  const found = [/'([^'\n]+)'/g, /"([^"\n]+)"/g, /`([^`\n]+)`/g].flatMap((re) => [...code.matchAll(re)].map((m) => m[1]!));
  return found.filter((t) => t.trim().length >= 4 && /[A-Za-z]/.test(t));
};

/** The words a reader actually has to understand: no code, no on-screen app text. */
const readable = (text: string, exempt: string[]): string => {
  let out = text.replace(/`[^`]*`/g, PLACEHOLDER);
  for (const t of exempt) out = out.split(t).join(PLACEHOLDER);
  return out;
};

export const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])["'”’)]*\s+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));

const wordCount = (sentence: string): number => sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}…]/u.test(w)).length;

const opening = (sentence: string): string => {
  const words = sentence.split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(' ')}…` : sentence;
};

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export const checkPlainEnglish = (lesson: Lesson): PlainCheck => {
  const problems: string[] = [];
  const exempt = appText(lesson);

  const fields: { label: string; text: string }[] = [
    { label: 'title', text: lesson.title },
    ...lesson.story.map((text, i) => ({ label: `story paragraph ${i + 1}`, text })),
    { label: 'plainWords', text: lesson.plainWords },
    { label: 'question', text: lesson.question },
    ...(['A', 'B', 'C'] as const).map((l) => ({ label: `option ${l}`, text: lesson.options[l] })),
    ...(['A', 'B', 'C'] as const).map((l) => ({ label: `feedback ${l}`, text: lesson.feedback[l] })),
  ];

  for (const { label, text } of fields) {
    const plain = readable(text, exempt);

    for (const { re } of jargonPatterns) {
      const hit = plain.match(re);
      if (hit) problems.push(`${label} uses "${hit[0]}", say it in everyday words`);
    }

    const names = new Set([...plain.matchAll(IDENTIFIER)].map((m) => m[0]).filter((n) => !BRAND_NAMES.has(n)));
    for (const name of names) {
      problems.push(`${label} uses the code name "${name}"; put it in backticks and say what it does in everyday words`);
    }

    for (const sentence of sentencesOf(plain)) {
      const n = wordCount(sentence);
      if (n > SENTENCE_MAX_WORDS) {
        problems.push(`${label} has a sentence of ${n} words ("${opening(sentence)}"); split it so each sentence has ${SENTENCE_MAX_WORDS} words or fewer`);
      }
    }

    const naming = text.match(NAMING);
    if (naming) problems.push(`${label} says "${naming[0]}"; drop the name and just explain the idea`);
  }

  if (lesson.title.length > TITLE_MAX) {
    problems.push(`title is ${lesson.title.length} characters; make it ${TITLE_MAX} or fewer`);
  }

  if (lesson.story.length > STORY_MAX_PARAGRAPHS) {
    problems.push(`story has ${lesson.story.length} paragraphs; use 2 to ${STORY_MAX_PARAGRAPHS}`);
  }
  lesson.story.forEach((paragraph, i) => {
    const n = sentencesOf(readable(paragraph, exempt)).length;
    if (n > PARAGRAPH_MAX_SENTENCES) {
      problems.push(`story paragraph ${i + 1} has ${n} sentences; use ${PARAGRAPH_MAX_SENTENCES} or fewer`);
    }
  });

  // A quiz whose right answer is already printed in the story tests copying, not understanding.
  const right = normalize(lesson.options[lesson.answer]).replace(/[.!?]+$/, '');
  if (right.split(' ').length >= 2 && normalize(lesson.story.join(' ')).includes(right)) {
    problems.push(`the right answer (${lesson.answer}) appears word for word in the story; ask about a new situation the story does not already answer`);
  }

  return { passed: problems.length === 0, problems };
};
