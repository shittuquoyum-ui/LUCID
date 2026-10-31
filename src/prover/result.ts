/**
 * What a proof comes back as. Kept apart from the prover itself, so the card
 * and the extension can read results without pulling the sandbox code in.
 */
import type { Usage } from '../engine/model';
import type { Action, Actor, ToolCall } from './attack';
import type { Verdict } from './judge';

export type ProofStatus = 'proven' | 'not-reproduced' | 'error';
export type BeforeState = 'blocked' | 'leaked' | 'no-table' | 'not-run' | 'error';

export interface ProofResult {
  status: ProofStatus;
  table: string | null;
  role: Actor | null;
  action: Action | null;
  /** How many of Alice's rows were read, changed or deleted. */
  rows: number;
  /** The exact query that did it. */
  query: string | null;
  /** Who wrote that query: the standard probes, or the attacker model. */
  foundBy: 'probe' | 'attacker' | null;
  /** The same query on the database as it was before the commit. */
  before: BeforeState;
  /** Why there is no proof (or what went wrong). */
  reason: string | null;
  judge: Verdict | null;
  /** The read worked, on data that looks meant for everyone. No proof; the card says what the change does. */
  publicRead?: boolean;
  /** A short account of what the prover tried. */
  summary: string;
  /** Every tool call, in order (outputs trimmed). */
  log: ToolCall[];
  timings: { setupMs: number; attackMs: number; judgeMs: number; beforeMs: number; totalMs: number };
  usage: { attacker: Usage; judge: Usage };
}

/** The one statement every proof stands on. Never "real data", never "safe". */
export const PROOF_STATEMENT = 'Reproduced unauthorized access against fake users, using your database rules, in a disposable sandbox.';
