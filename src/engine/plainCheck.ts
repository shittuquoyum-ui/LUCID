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
 *   - words the app itself shows on screen: quoted text (in the lesson or in
 *     its quoted code) that also appears, case-insensitively, in the changed
 *     lines of the diff. 'Validation failed' is what people see, not jargon;
 *     a quoted 'object' that the change never shows still counts.
 */
import type { Lesson } from './schemas';

export const TITLE_MAX = 60;
export const SENTENCE_MAX_WORDS = 20;
export const STORY_MAX_PARAGRAPHS = 4;
export const PARAGRAPH_MAX_SENTENCES = 3;
export const PLAIN_WORDS_MAX_WORDS = 25;
export const PLAIN_WORDS_MAX_SENTENCES = 2;

export const JARGON = [
  'field', 'function', 'variable', 'object', 'array', 'string', 'boolean', 'null', 'undefined', 'async', 'await',
  'promise', 'callback', 'API', 'endpoint', 'schema', 'query', 'component', 'props', 'state', 'hook',
  'render', 'middleware', 'validation', 'exception', 'error handling', 'parse', 'instance', 'class',
  'method', 'type', 'interface', 'runtime',
];

/** An everyday word to suggest, where one fits most cases. */
const EVERYDAY: Record<string, string> = { field: 'box' };

/** Product names that happen to look like code names. */
const BRAND_NAMES = new Set(['GitHub', 'iPhone', 'iPad', 'YouTube', 'PayPal', 'LinkedIn', 'WhatsApp', 'WordPress']);

export interface PlainCheck {
  passed: boolean;
  problems: string[];
}

const jargonPatterns = JARGON.map((word) => ({
  re: new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i'),
  hint: EVERYDAY[word] ? ` (try "${EVERYDAY[word]}")` : '',
}));
// Three or more words glued with hyphens ("or-if-empty"); ordinary pairs like "sign-in" are fine.
const HYPHEN_GLUED = /[\p{L}]+(?:-[\p{L}]+){2,}/u;
const IDENTIFIER = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g;
const NAMING = /\b(?:that['’]?s|that is|this is) called\b/i;
const PLACEHOLDER = '`…`';

const CODE_QUOTES = [/'([^'\n]+)'/g, /"([^"\n]+)"/g, /`([^`\n]+)`/g];
// In prose a single quote is often an apostrophe ("it's"), so only count quotes that open and close at word edges.
const PROSE_QUOTES = [/(?<![\p{L}\p{N}])['‘]((?:[^'‘’\n]|['’](?=[\p{L}]))+)['’](?![\p{L}\p{N}])/gu, /["“]([^"“”\n]+)["”]/g];

const quotedIn = (text: string, patterns: RegExp[]): string[] => patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));

/**
 * Words the app shows to its users: quoted text from the lesson or its quoted
 * code, kept only when the change itself contains it.
 */
const appText = (lesson: Lesson, changedLines: string[]): string[] => {
  const changed = changedLines.join('\n').toLowerCase();
  const prose = [lesson.title, ...lesson.story, lesson.plainWords, lesson.question, ...Object.values(lesson.options), ...Object.values(lesson.feedback)];
  const candidates = [
    ...quotedIn(lesson.quotes.map((q) => q.code).join('\n'), CODE_QUOTES),
    ...prose.flatMap((t) => quotedIn(t, PROSE_QUOTES)),
  ];
  return [...new Set(candidates)].filter((t) => t.trim().length >= 4 && /[A-Za-z]/.test(t) && changed.includes(t.toLowerCase()));
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words a reader actually has to understand: no code, no on-screen app text. */
const readable = (text: string, exempt: string[]): string => {
  let out = text.replace(/`[^`]*`/g, PLACEHOLDER);
  for (const t of exempt) out = out.replace(new RegExp(escapeRegExp(t), 'gi'), PLACEHOLDER);
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

/** `changedLines`: the text of the diff's added and removed lines, for the on-screen-text exemption. */
export const checkPlainEnglish = (lesson: Lesson, changedLines: string[] = []): PlainCheck => {
  const problems: string[] = [];
  const exempt = appText(lesson, changedLines);

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

    for (const { re, hint } of jargonPatterns) {
      const hit = plain.match(re);
      if (hit) problems.push(`${label} uses "${hit[0]}", say it in everyday words${hint}`);
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

  // plainWords should sound like something a person says out loud.
  const said = readable(lesson.plainWords, exempt);
  const saidWords = wordCount(said);
  if (saidWords > PLAIN_WORDS_MAX_WORDS) {
    problems.push(`plainWords has ${saidWords} words; say it in ${PLAIN_WORDS_MAX_WORDS} words or fewer`);
  }
  const saidSentences = sentencesOf(said).length;
  if (saidSentences > PLAIN_WORDS_MAX_SENTENCES) {
    problems.push(`plainWords has ${saidSentences} sentences; use one or two normal sentences`);
  }
  const glued = said.match(HYPHEN_GLUED);
  if (glued) problems.push(`plainWords glues words with hyphens ("${glued[0]}"); write them as a normal sentence`);

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
