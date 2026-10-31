/**
 * The judge: after the ground truth shows someone else could read Alice's
 * rows, and plain code could not settle it (see intent.ts), a second model
 * (Muse Spark Open, Baseten) looks at the table's columns and rules and the
 * commit, and says whether this is data clearly meant for everyone (published
 * posts, a product list). Clearly public means no proof.
 *
 * Only reads are judged: changing or deleting someone else's row is never
 * fine, whatever the table holds.
 */
import { z } from 'zod';
import { parseWith } from '../engine/json';
import { callModel, type Provider, type Usage } from '../engine/model';
import { prompt } from '../engine/prompts';
import type { Evidence } from './attack';
import type { TableInfo } from './schema';

export const JudgeSchema = z.object({
  clearlyPublic: z.boolean(),
  reason: z.string().min(1).max(400),
});

export interface Verdict {
  clearlyPublic: boolean;
  reason: string;
}

export interface JudgeFacts {
  /** The definitions of the views and functions the query used, if any. */
  through?: string[];
  /** The setup lines this commit added. */
  commit?: string;
}

export const judgeInput = (table: TableInfo, evidence: Evidence, facts: JudgeFacts = {}): string =>
  JSON.stringify(
    {
      table: table.name,
      columns: table.columns.map((c) => `${c.name} ${c.type}`),
      policies: table.policies.map((p) => ({ name: p.name, command: p.command, roles: p.roles, using: p.using, withCheck: p.withCheck })),
      reachedBy: evidence.actor === 'anon' ? 'a signed-out visitor' : 'another signed-in user',
      query: evidence.query,
      ...(facts.through?.length ? { through: facts.through } : {}),
      ...(evidence.hiddenByTableRule ? { hiddenByTableRule: true } : {}),
      ...(facts.commit ? { commit: facts.commit.slice(0, 4000) } : {}),
    },
    null,
    2,
  );

/** The verdict, or null when the judge never gave a valid one. */
export const judgePrivacy = async (table: TableInfo, evidence: Evidence, provider: Provider, usage?: Usage, facts: JudgeFacts = {}): Promise<Verdict | null> => {
  const system = prompt('judgePrivacy');
  let problems: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const note = problems.length ? `\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${problems.join('; ')}. Answer with the JSON only.` : '';
    const text = await callModel(provider, { system, user: judgeInput(table, evidence, facts) + note, effort: 'low', maxTokens: 3000, usage }, () =>
      JSON.stringify({ clearlyPublic: false, reason: 'fake judge' }),
    );
    const parsed = parseWith(JudgeSchema, text);
    if (parsed.ok) return parsed.value;
    problems = parsed.problems;
  }
  return null;
};

/** A read of data clearly meant for everyone is no proof. A change or a delete always stands. */
export const downgrade = (evidence: Evidence, verdict: Verdict | null): { keep: boolean; reason: string | null } => {
  if (evidence.action !== 'read') return { keep: true, reason: null };
  if (!verdict) return { keep: false, reason: 'the privacy judge gave no verdict, so Lucid does not claim a proof' };
  if (verdict.clearlyPublic) return { keep: false, reason: `the data looks meant for everyone: ${verdict.reason}` };
  return { keep: true, reason: null };
};
