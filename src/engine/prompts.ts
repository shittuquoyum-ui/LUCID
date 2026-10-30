/**
 * The prompt texts. The CLI and tests read them from src/prompts/*.md. The
 * editor extension bundles them as text and hands them over with
 * providePrompts, so the bundle never reads a file at run time.
 */
import { readFileSync } from 'node:fs';

export type PromptName = 'pickConcept' | 'writeLesson' | 'reviewLesson' | 'writeWarning' | 'reviewWarning';

const provided: Partial<Record<PromptName, string>> = {};

export const providePrompts = (texts: Record<PromptName, string>): void => {
  Object.assign(provided, texts);
};

export const prompt = (name: PromptName): string =>
  provided[name] ?? readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
