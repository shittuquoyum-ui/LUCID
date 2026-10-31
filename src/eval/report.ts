/**
 * The red-team evaluation's arithmetic and its report, as plain code so a
 * test can check that a false proof is never quiet. scripts/eval.ts runs the
 * commits; this turns what happened into numbers.
 *
 * "In the product" means what a builder gets: a proof runs only after a
 * data-exposure warning. "Prover alone" forces the prover on every commit
 * with database setup, warned or not, so a false proof cannot hide behind a
 * warning that never fired.
 */
import type { Usage } from '../engine/model';

export interface EvalRow {
  id: string;
  label: 'risky' | 'safe';
  what: string;
  /** Held out: generated after the prompts and signals were frozen, in shapes they never mention. Never tuned on. */
  source: 'authored' | 'generated' | 'held-out';
  /** A database-rule leak the sandbox can try to reproduce. */
  provable: boolean;
  /** Set when the run itself failed; the other fields then say little. */
  error: string | null;
  outcome: string;
  warned: boolean;
  category: string | null;
  severity: string | null;
  /** 'passed', 'failed', 'dropped' (the check stopped a warning), or null when nothing was checked. */
  factCheck: string | null;
  /** The product would have run the prover on this commit. */
  gated: boolean;
  /** Null when the commit has no database setup to prove with. */
  proof: EvalProof | null;
  warningMs: number;
  usage: { pick: Usage | null; write: Usage | null; review: Usage | null };
}

export interface EvalProof {
  status: 'proven' | 'not-reproduced' | 'error';
  foundBy: 'probe' | 'attacker' | null;
  before: string;
  action: string | null;
  role: string | null;
  table: string | null;
  query: string | null;
  reason: string | null;
  agentCalls: number;
  ms: number;
  usage: { attacker: Usage; judge: Usage };
}

export interface Prices {
  /** Dollars per million tokens. */
  pickReview: { input: number; output: number };
  writeAttack: { input: number; output: number };
  sandboxPerSecond: number;
}

const tokensOf = (u: Usage | null | undefined) => (u ? u.input + u.output : 0);

export const tokens = (r: EvalRow): number =>
  tokensOf(r.usage.pick) + tokensOf(r.usage.write) + tokensOf(r.usage.review) + tokensOf(r.proof?.usage.attacker) + tokensOf(r.proof?.usage.judge);

const dollars = (u: Usage | null | undefined, p: { input: number; output: number }) => (u ? (u.input * p.input + u.output * p.output) / 1_000_000 : 0);

/** Rough cost of one commit: models at the prices given, sandbox per second. */
export const cost = (r: EvalRow, p: Prices): number =>
  dollars(r.usage.pick, p.pickReview) +
  dollars(r.usage.review, p.pickReview) +
  dollars(r.proof?.usage.judge, p.pickReview) +
  dollars(r.usage.write, p.writeAttack) +
  dollars(r.proof?.usage.attacker, p.writeAttack) +
  ((r.proof?.ms ?? 0) / 1000) * p.sandboxPerSecond;

/** The value at this share of the sorted list, nearest rank. */
export const percentile = (values: number[], share: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]!;
};

export interface EvalSummary {
  commits: number;
  errors: string[];
  risky: { total: number; caught: number; missed: string[] };
  safe: { total: number; warned: number; falseWarnings: string[] };
  proofs: {
    provable: number;
    /** In the product: warned, then proven. */
    inProduct: number;
    /** With the prover forced on every commit with database setup. */
    proverAlone: number;
    byProbe: number;
    byAttacker: number;
    errors: string[];
    /** Safe commits proven in the product, or by the prover alone. Must both be empty. */
    falseProofsInProduct: string[];
    falseProofsProverAlone: string[];
  };
  time: { warningMedianMs: number; warningP90Ms: number; totalMedianMs: number; totalP90Ms: number; proofMedianMs: number; proofP90Ms: number };
  tokens: { total: number; perCommit: number };
  cost: { total: number; perCommit: number };
}

export const summarize = (rows: EvalRow[], prices: Prices): EvalSummary => {
  const clean = rows.filter((r) => !r.error);
  const risky = clean.filter((r) => r.label === 'risky');
  const safe = clean.filter((r) => r.label === 'safe');
  const provable = clean.filter((r) => r.provable);
  const proven = (r: EvalRow) => r.proof?.status === 'proven';
  const inProduct = (r: EvalRow) => r.gated && proven(r);
  const proofs = clean.filter((r) => r.proof);
  const provenRisky = provable.filter(proven);
  const totalTokens = clean.reduce((n, r) => n + tokens(r), 0);
  const totalCost = clean.reduce((n, r) => n + cost(r, prices), 0);
  const warningMs = clean.map((r) => r.warningMs);
  const totalMs = clean.map((r) => r.warningMs + (r.gated ? (r.proof?.ms ?? 0) : 0));
  const proofMs = proofs.map((r) => r.proof!.ms);
  return {
    commits: rows.length,
    errors: rows.filter((r) => r.error).map((r) => r.id),
    risky: { total: risky.length, caught: risky.filter((r) => r.warned).length, missed: risky.filter((r) => !r.warned).map((r) => r.id) },
    safe: { total: safe.length, warned: safe.filter((r) => r.warned).length, falseWarnings: safe.filter((r) => r.warned).map((r) => r.id) },
    proofs: {
      provable: provable.length,
      inProduct: provable.filter(inProduct).length,
      proverAlone: provenRisky.length,
      byProbe: provenRisky.filter((r) => r.proof!.foundBy === 'probe').length,
      byAttacker: provenRisky.filter((r) => r.proof!.foundBy === 'attacker').length,
      errors: proofs.filter((r) => r.proof!.status === 'error').map((r) => r.id),
      falseProofsInProduct: safe.filter(inProduct).map((r) => r.id),
      falseProofsProverAlone: safe.filter(proven).map((r) => r.id),
    },
    time: {
      warningMedianMs: percentile(warningMs, 0.5),
      warningP90Ms: percentile(warningMs, 0.9),
      totalMedianMs: percentile(totalMs, 0.5),
      totalP90Ms: percentile(totalMs, 0.9),
      proofMedianMs: percentile(proofMs, 0.5),
      proofP90Ms: percentile(proofMs, 0.9),
    },
    tokens: { total: totalTokens, perCommit: clean.length ? Math.round(totalTokens / clean.length) : 0 },
    cost: { total: totalCost, perCommit: clean.length ? totalCost / clean.length : 0 },
  };
};

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '-');
const yn = (b: boolean) => (b ? 'yes' : 'no');
const cell = (v: string | null | undefined) => (v ?? '-').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const proofCell = (r: EvalRow): string => {
  if (!r.proof) return '-';
  if (r.proof.status === 'error') return 'error';
  if (r.proof.status !== 'proven') return 'no';
  return `yes (${r.proof.foundBy}, ${r.gated ? 'in product' : 'prover alone'})`;
};

const row = (r: EvalRow, p: Prices): string =>
  r.error
    ? `| ${r.id} | ${r.label} | ${r.source} | **run failed** | | | | | | | ${cell(r.error)} |`
    : `| ${r.id} | ${r.label} | ${r.source} | ${yn(r.warned)} | ${cell(r.category)} | ${cell(r.severity)} | ${proofCell(r)} | ${cell(r.factCheck)} | ${s(r.warningMs + (r.gated ? (r.proof?.ms ?? 0) : 0))} | ${tokens(r).toLocaleString('en-US')} | $${cost(r, p).toFixed(4)} |`;

export interface ReportMeta {
  date: string;
  gitSha: string;
  models: string;
  where: string;
  concurrency: number;
  priceNote: string;
}

/** Everything that must never be missed, or nothing when the run was clean. */
export const alarms = (x: EvalSummary): string[] => [
  ...(x.proofs.falseProofsInProduct.length ? [`🚨 FALSE PROOF in the product on safe commits: ${x.proofs.falseProofsInProduct.join(', ')}`] : []),
  ...(x.proofs.falseProofsProverAlone.length ? [`🚨 FALSE PROOF by the prover alone on safe commits: ${x.proofs.falseProofsProverAlone.join(', ')}`] : []),
  ...(x.safe.falseWarnings.length ? [`⚠️ FALSE WARNING on safe commits: ${x.safe.falseWarnings.join(', ')}`] : []),
  ...(x.risky.missed.length ? [`⚠️ MISSED risky commits: ${x.risky.missed.join(', ')}`] : []),
  ...(x.proofs.errors.length ? [`⚠️ The prover errored on: ${x.proofs.errors.join(', ')}`] : []),
  ...(x.errors.length ? [`⚠️ These commits failed to run and are not in the numbers: ${x.errors.join(', ')}`] : []),
];

export const renderReport = (rows: EvalRow[], prices: Prices, meta: ReportMeta): string => {
  const x = summarize(rows, prices);
  const flags = alarms(x);
  const of = (source: EvalRow['source']) => {
    const these = rows.filter((r) => r.source === source && !r.error);
    const risky = these.filter((r) => r.label === 'risky');
    const safe = these.filter((r) => r.label === 'safe');
    return `${risky.filter((r) => r.warned).length} of ${risky.length} risky caught, ${safe.filter((r) => r.warned).length} of ${safe.length} safe warned`;
  };
  return `# Lucid red-team evaluation

${meta.date}, commit \`${meta.gitSha}\`. ${meta.where}. Models: ${meta.models}. ${meta.concurrency} commits at a time.

${flags.length ? flags.map((f) => `**${f}**`).join('\n\n') : 'No false proofs, false warnings, misses or errors in this run.'}

## Summary

| Measure | Result |
|---|---|
| Commits | ${x.commits} (${x.risky.total} risky, ${x.safe.total} safe) |
| Warnings on risky commits | **${x.risky.caught} of ${x.risky.total}** (${pct(x.risky.caught, x.risky.total)}) |
| False warnings on safe commits | **${x.safe.warned} of ${x.safe.total}** (${pct(x.safe.warned, x.safe.total)}) |
| Proofs among data-exposure cases, in the product | **${x.proofs.inProduct} of ${x.proofs.provable}** (${pct(x.proofs.inProduct, x.proofs.provable)}) |
| Proofs among data-exposure cases, prover alone | ${x.proofs.proverAlone} of ${x.proofs.provable} (${x.proofs.byProbe} by the standard probes, ${x.proofs.byAttacker} by the attacker model) |
| False proofs on safe commits | **${x.proofs.falseProofsInProduct.length} in the product, ${x.proofs.falseProofsProverAlone.length} by the prover alone** (must be 0) |
| Time to the card | median ${s(x.time.warningMedianMs)}, p90 ${s(x.time.warningP90Ms)} |
| Time for a proof | median ${s(x.time.proofMedianMs)}, p90 ${s(x.time.proofP90Ms)} |
| Time for a commit, card and proof | median ${s(x.time.totalMedianMs)}, p90 ${s(x.time.totalP90Ms)} |
| Tokens | ${x.tokens.total.toLocaleString('en-US')} in all, ${x.tokens.perCommit.toLocaleString('en-US')} per commit |
| Rough cost | $${x.cost.total.toFixed(2)} in all, $${x.cost.perCommit.toFixed(4)} per commit |

By source: hand-written: ${of('authored')}. Written by Muse Spark: ${of('generated')}. Held out: ${of('held-out')}.

"In the product" means what a builder gets: a proof runs only after a data-exposure warning. "Prover alone" forces the prover on every commit with database setup, warned or not. Rough cost: ${meta.priceNote}

## Every commit

| Commit | Truth | Source | Warned | Category | Severity | Proved | Fact check | Time | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.map((r) => row(r, prices)).join('\n')}

## How to read this

- A small test set, not a measure of the world. Most commits were written by the people who built Lucid, while its prompts and risk signals were being tuned on the same kinds of mistake, so the hand-written score is flattering. The generated ones come from the same model family that detects them, so they are fresher but not independent.
- The held-out commits are the fairest numbers here. They were generated after the prompts and signals were frozen, in shapes those never mention, and nothing was tuned on them afterwards.
- A miss is a commit with no warning card. A warning the fact check dropped counts as a miss: the builder hears nothing.
- Time is wall clock per commit with ${meta.concurrency} running at once, so it includes queueing at the model APIs. The proof runs in the background after the card is shown.
- A "not proven" says nothing about safety. Proofs run in a disposable sandbox against fake users.

Run it again with \`npm run eval\`. Model answers vary between runs, so expect small differences.
`;
};
