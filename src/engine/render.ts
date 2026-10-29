/**
 * Turning a checked lesson into the comment posted on the pull request.
 * Same layout as the lesson card, minus the buttons: readers reply A, B or C.
 */
import { createHmac } from 'node:crypto';
import type { CheckedLesson, VerifiedQuote } from './quoteCheck';

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

export const lineLabel = (q: { line: number; endLine: number }): string =>
  q.endLine > q.line ? `lines ${q.line}–${q.endLine}` : `line ${q.line}`;

const where = (q: VerifiedQuote): string => {
  const label = `\`${q.file}\` ${lineLabel(q)}${q.role === 'removed' ? ' (removed in this change)' : ''}`;
  return q.link ? `[${label}](${q.link})` : label;
};

const codeBlock = (q: VerifiedQuote): string => {
  const f = fence(q.code);
  return `${f}${languageOf(q.file)}\n${q.code}\n${f}`;
};

const LETTERS = ['A', 'B', 'C'] as const;

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

export const renderComment = (lesson: CheckedLesson, options: RenderOptions): string => {
  const [key, extra] = lesson.quotes;
  if (!key) throw new Error('a lesson needs at least one verified quote');
  const code = answerCode(options.lessonId, lesson.answer);
  const marker = `<!-- lucid:lesson v1 id=${options.lessonId} concept=${options.concept}${code ? ` check=${code}` : ''} -->`;

  return [
    '<sub>🔍 LUCID · WHAT THIS CHANGE DOES</sub>',
    '',
    `### ${lesson.title}`,
    '',
    lesson.story.join('\n\n'),
    '',
    `**The line that does it** · ${where(key)}`,
    codeBlock(key),
    '',
    `**In plain words:** ${lesson.plainWords}`,
    ...(extra ? ['', `**Also in this change** · ${where(extra)}: ${extra.note}`, codeBlock(extra)] : []),
    '',
    '#### Quick check',
    '',
    lesson.question,
    '',
    LETTERS.map((l) => `**${l}.** ${lesson.options[l]}`).join('  \n'),
    '',
    'Reply with **A**, **B** or **C**.',
    '',
    '<details><summary>Show the answer</summary>',
    '',
    LETTERS.map((l) => `${l === lesson.answer ? '✅' : '❌'} **${l}.** ${lesson.feedback[l]}`).join('  \n'),
    '',
    '</details>',
    '',
    '<sub>Every quote is checked against your code · Lucid stores nothing</sub>',
    marker,
  ].join('\n');
};
