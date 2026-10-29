/**
 * Turning a checked lesson into the comment posted on the pull request.
 */
import { createHmac } from 'node:crypto';
import { conceptById } from '../concepts';
import type { VerifiedQuote } from './quoteCheck';
import type { Lesson } from './schemas';

const LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', sql: 'sql', py: 'python',
  rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', css: 'css', scss: 'scss',
  html: 'html', vue: 'vue', svelte: 'svelte', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', toml: 'toml',
  php: 'php', cs: 'csharp', dart: 'dart', prisma: 'prisma', graphql: 'graphql',
};

export const languageOf = (path: string): string => LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? '';

/** A fence longer than any run of backticks in the code, so code can never break out of it. */
const fence = (code: string): string => {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(longest + 1);
};

const lineLabel = (q: VerifiedQuote): string =>
  q.endLine > q.line ? `lines ${q.line}–${q.endLine}` : `line ${q.line}`;

const renderQuote = (q: VerifiedQuote): string => {
  const where = `\`${q.file}\` ${lineLabel(q)}${q.role === 'removed' ? ' (removed in this change)' : ''}`;
  const heading = q.link ? `[${where}](${q.link})` : where;
  const f = fence(q.code);
  return `**${heading}**: ${q.note}\n${f}${languageOf(q.file)}\n${q.code}\n${f}`;
};

/**
 * A short code that lets the bot grade a reply later without storing the
 * answer anywhere: HMAC(secret, lessonId + answer). Without a secret, no code.
 */
export const answerCode = (lessonId: string, answer: string, secret = process.env.LUCID_SECRET): string | null =>
  secret ? createHmac('sha256', secret).update(`${lessonId}:${answer}`).digest('hex').slice(0, 16) : null;

export interface RenderOptions {
  concept: string;
  /** Stable id for this lesson (e.g. head commit + concept); used by the quick check. */
  lessonId: string;
}

export const renderComment = (lesson: Lesson & { quotes: VerifiedQuote[] }, options: RenderOptions): string => {
  const concept = conceptById(options.concept);
  const code = answerCode(options.lessonId, lesson.answer);
  const marker = `<!-- lucid:lesson v1 id=${options.lessonId} concept=${options.concept}${code ? ` check=${code}` : ''} -->`;

  return [
    `### 🔍 Lucid · ${lesson.title}`,
    '',
    lesson.explanation,
    '',
    '#### In your code',
    '',
    lesson.quotes.map(renderQuote).join('\n\n'),
    '',
    `> ⚠️ **If this goes wrong:** ${lesson.breaksIf}`,
    '',
    '#### Quick check',
    '',
    lesson.question,
    '',
    `**A.** ${lesson.options.A}  `,
    `**B.** ${lesson.options.B}  `,
    `**C.** ${lesson.options.C}`,
    '',
    'Reply with **A**, **B** or **C**.',
    '',
    '<details><summary>Show the answer</summary>',
    '',
    `**${lesson.answer}.** ${lesson.answerWhy}`,
    '',
    '</details>',
    '',
    `<sub>Lucid explained one change in this PR${concept ? `: ${concept.name.toLowerCase()}` : ''}. Every quote above was checked against the diff. Lucid stores nothing.</sub>`,
    marker,
  ].join('\n');
};
