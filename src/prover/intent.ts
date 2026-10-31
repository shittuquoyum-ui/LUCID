/**
 * Is a read a leak, or data the builder means to publish? Plain code, so the
 * firm cases never depend on how a model feels that day:
 *
 *   - names that look private were reached: the proof stands, whatever the
 *     commit calls it. A public page that shows emails is still a leak.
 *   - the commit clearly means to publish: no proof, at most a warning.
 *   - anything else: the privacy judge decides.
 *
 * "Blocked before this commit" is no part of this. Every commit that opens a
 * table was blocked before, on purpose or not, so it says nothing either way.
 */
import type { Evidence } from './attack';
import type { TableInfo } from './schema';

export type ReadCall = { kind: 'private'; names: string[] } | { kind: 'publish'; signal: string } | { kind: 'unclear' };

const words = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const PRIVATE = new Set([
  'email', 'emails', 'phone', 'phones', 'mobile', 'address', 'addresses', 'payment', 'payments', 'card', 'iban', 'invoice', 'invoices',
  'ssn', 'salary', 'password', 'secret', 'secrets', 'token', 'tokens', 'private', 'note', 'notes', 'message', 'messages', 'dob', 'birthday', 'medical', 'health',
]);
const PUBLISH = new Set(['public', 'publicly', 'published', 'leaderboard', 'leaderboards']);
/** Links, times and flags: `note_id`, `is_private` or `email_verified` hold none of what their names mention. */
const NO_CONTENT = /(^id$|_id$|_at$|^is_|^has_|_verified$|_confirmed$)/i;
const PUBLIC_COLUMN = /^(display_?name|user_?name|nickname|handle|avatar|avatar_url|bio|score|points|rank|rating|wins|losses|level|slug)$/i;
const PUBLISH_COMMENT = /--.*(?:\bpublic(?:ly)?\b|\bpublished\b|\bleaderboards?\b|\bfor everyone\b|\banyone can (?:see|read|view)\b)/i;

const says = (name: string, set: Set<string>) => words(name).some((w) => set.has(w));

/** The names that look private among what was reached. A table named for publishing is not private by its name alone. */
export const privateNames = (table: string, columns: string[]): string[] => [
  ...(says(table, PRIVATE) && !says(table, PUBLISH) ? [table] : []),
  ...columns.filter((c) => !NO_CONTENT.test(c) && says(c, PRIVATE)),
];

export interface ReadFacts {
  table: TableInfo;
  evidence: Evidence;
  /** The views and functions the query went through. */
  routes: string[];
  /** The setup lines this commit added. */
  commit: string;
}

/** What in the commit says this is meant for everyone, or null. */
const publishSignal = ({ table, evidence, routes, commit }: ReadFacts, columns: string[]): string | null => {
  const route = routes.find((r) => says(r, PUBLISH));
  if (route) return `the name ${route}`;
  const content = columns.filter((c) => !NO_CONTENT.test(c));
  if (content.length && content.every((c) => PUBLIC_COLUMN.test(c))) return `only public-looking columns (${content.join(', ')})`;
  // The table's own rule hides this row from this person, so what the table is called says nothing about it.
  if (evidence.hiddenByTableRule) return null;
  if (says(table.name, PUBLISH)) return `the name ${table.name}`;
  const policy = table.policies.find((p) => (p.command === 'SELECT' || p.command === 'ALL') && says(p.name, PUBLISH) && commit.includes(p.name));
  if (policy) return `the rule "${policy.name}"`;
  return commit.split('\n').some((l) => PUBLISH_COMMENT.test(l)) ? 'a comment in the commit' : null;
};

export const callRead = (facts: ReadFacts): ReadCall => {
  const columns = facts.evidence.columns?.length ? facts.evidence.columns : facts.table.columns.map((c) => c.name);
  const names = privateNames(facts.table.name, columns);
  if (names.length) return { kind: 'private', names };
  const signal = publishSignal(facts, columns);
  return signal ? { kind: 'publish', signal } : { kind: 'unclear' };
};
