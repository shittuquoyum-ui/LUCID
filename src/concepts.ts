/**
 * The concepts Lucid can teach. The concept picker must choose one of these
 * ids, which keeps lessons on solid ground and lets later features count
 * concepts across projects.
 */
export interface Concept {
  id: string;
  name: string;
  /** One plain-English line a non-coder would understand. */
  plain: string;
}

export const CONCEPTS = [
  { id: 'authentication', name: 'Authentication and sessions', plain: 'How the app knows who you are after you sign in.' },
  { id: 'authorization', name: 'Authorization and permissions', plain: 'Deciding what a signed-in person is allowed to see or change.' },
  { id: 'row-level-security', name: 'Row-level security', plain: 'Database rules that stop people reading or editing rows that are not theirs.' },
  { id: 'secrets-and-env', name: 'Secrets and environment variables', plain: 'Keeping keys and passwords out of the code and out of the browser.' },
  { id: 'database-schema', name: 'Database tables and migrations', plain: 'How the shape of your data is defined and changed safely over time.' },
  { id: 'unique-keys-upserts', name: 'Unique keys and upserts', plain: 'Stopping the same thing being saved twice.' },
  { id: 'api-routes', name: 'API routes and server code', plain: 'Code that runs on a server instead of in the visitor\'s browser.' },
  { id: 'input-validation', name: 'Input validation', plain: 'Checking what users or other systems send before trusting it.' },
  { id: 'error-handling', name: 'Error handling', plain: 'What the app does when something fails, instead of breaking silently.' },
  { id: 'async-code', name: 'Async code', plain: 'Waiting for slow things (network, database) without freezing the app.' },
  { id: 'state-and-data-flow', name: 'State and data flow', plain: 'Where the app keeps changing information and how screens stay in sync.' },
  { id: 'types', name: 'Types', plain: 'Labels that describe the shape of data so mistakes are caught early.' },
  { id: 'caching', name: 'Caching', plain: 'Remembering results so the app does not redo slow work.' },
  { id: 'performance', name: 'Performance', plain: 'Making the app load and respond faster.' },
  { id: 'accessibility', name: 'Accessibility', plain: 'Making the app usable for everyone, including screen-reader and keyboard users.' },
  { id: 'testing', name: 'Testing', plain: 'Code that checks your code still works after a change.' },
  { id: 'git-workflow', name: 'Git branches and pull requests', plain: 'How changes are proposed, reviewed and merged.' },
  { id: 'dependencies', name: 'Dependencies', plain: 'Other people\'s code your app relies on, and the risks that come with it.' },
] as const satisfies readonly Concept[];

export type ConceptId = (typeof CONCEPTS)[number]['id'];

export const CONCEPT_IDS = CONCEPTS.map((c) => c.id) as [ConceptId, ...ConceptId[]];

export const conceptById = (id: string): Concept | undefined => CONCEPTS.find((c) => c.id === id);

export const conceptListForPrompt = (): string => CONCEPTS.map((c) => `- ${c.id}: ${c.name}. ${c.plain}`).join('\n');
