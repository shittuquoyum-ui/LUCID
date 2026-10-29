/**
 * The quick check: one multiple-choice question per lesson, graded by plain
 * code. No model call, nothing stored. It shows the builder followed this
 * lesson; it is not proof they have mastered the concept.
 */

export type Letter = 'A' | 'B' | 'C';

export type QuickCheckResult =
  | { status: 'correct'; letter: Letter }
  | { status: 'wrong'; letter: Letter }
  | { status: 'unclear' };

/**
 * Read an A, B or C out of a reply. Accepts "B", "b)", "(c)", "answer: A",
 * "my answer is b", "/lucid B". Anything else is unclear rather than a guess.
 */
export const readAnswer = (reply: string): Letter | null => {
  const text = reply.trim().replace(/^\/lucid\b\s*/i, '');
  const alone = text.match(/^[([]?\s*([abc])\s*[)\].:!]?$/i);
  if (alone) return alone[1]!.toUpperCase() as Letter;
  const stated = text.match(/\banswer\s*(?:is)?\s*[:\-=]?\s*[([]?\s*([abc])\b/i);
  if (stated) return stated[1]!.toUpperCase() as Letter;
  const leading = text.match(/^([abc])[).:\-]\s/i);
  if (leading) return leading[1]!.toUpperCase() as Letter;
  return null;
};

export const gradeReply = (reply: string, answer: Letter): QuickCheckResult => {
  const letter = readAnswer(reply);
  if (!letter) return { status: 'unclear' };
  return letter === answer ? { status: 'correct', letter } : { status: 'wrong', letter };
};
