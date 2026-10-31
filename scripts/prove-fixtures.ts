/**
 * The prover's integration test: runs the real prover (Modal sandbox,
 * Muse Spark attacker, Baseten judge) on the prover-app fixtures.
 *
 *   npm run -s prove:fixtures                  all of them, a–n
 *   npm run -s prove:fixtures -- a c           some
 *   npm run -s prove:fixtures -- --runs 5      each one five times
 *   npm run -s prove:fixtures -- --probes-only the standard probes alone, no attacker model
 *
 * a, b and c must come back "proven" with BEFORE blocked. f, g, h and i must
 * too, found by the attacker model: with --probes-only they must NOT be
 * proven, which is what shows the attacker earned them. d, e and j–n must
 * not be proven. Exits with 1 when any fixture does not.
 */
import { prove, type ProofResult } from '../src/prover/prove';
import { PROVER_COMMITS, proverCommit, type CommitLetter } from '../test/proverFixtures';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(value('--runs') ?? 1);
const probesOnly = flag('--probes-only');
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
const letters = (named.length ? named : Object.keys(PROVER_COMMITS)) as CommitLetter[];

// Modal prices (us-east, per second): CPU core and memory GiB. The sandbox has 1 core and 1 GiB.
const CORE_SECOND = 0.0000131;
const GIB_SECOND = 0.00000222;

/** What a commit must come back as. Probes alone must miss the leaks only the attacker model can reach. */
const passed = (letter: CommitLetter, r: ProofResult): boolean => {
  const commit = PROVER_COMMITS[letter];
  const needsAgent = 'needsAgent' in commit && commit.needsAgent;
  if (probesOnly && needsAgent) return r.status === 'not-reproduced';
  if (commit.expect !== 'proven') return r.status === 'not-reproduced';
  return r.status === 'proven' && r.before === 'blocked' && (!needsAgent || r.foundBy === 'attacker');
};

const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const agentCalls = (r: ProofResult) => r.log.filter((c) => c.by === 'attacker').length;

const main = async () => {
  let failures = 0;
  const rows: Record<string, { ok: boolean; r: ProofResult }[]> = {};
  for (let run = 1; run <= runs; run += 1) {
    const results = await Promise.all(
      letters.map(async (letter) => {
        const commit = proverCommit(letter);
        const r = await prove({ before: commit.before, after: commit.after, touched: commit.touched }, probesOnly ? { maxAgentCalls: 0 } : {});
        return { letter, r };
      }),
    );
    for (const { letter, r } of results) {
      const ok = passed(letter, r);
      if (!ok) failures += 1;
      (rows[letter] ??= []).push({ ok, r });
      const sandboxCost = (r.timings.totalMs / 1000) * (CORE_SECOND + GIB_SECOND);
      console.log(
        [
          `${letter} run ${run}/${runs} ${PROVER_COMMITS[letter].file}  ${ok ? 'PASS' : 'FAIL'} (expected ${probesOnly && 'needsAgent' in PROVER_COMMITS[letter] ? 'not proven by probes' : PROVER_COMMITS[letter].expect})`,
          `  status: ${r.status}${r.action ? `, ${r.role} ${r.action} ${r.rows} row(s) of ${r.table}` : ''}, before: ${r.before}, found by: ${r.foundBy ?? '-'}`,
          `  query:  ${(r.query ?? '-').replace(/\s+/g, ' ')}`,
          `  reason: ${r.reason ?? '-'}${r.judge ? `  | judge: ${r.judge.clearlyPublic ? 'public' : 'private'} (${r.judge.reason})` : ''}`,
          `  steps:  ${r.summary}`,
          `  time:   setup ${s(r.timings.setupMs)}, attack ${s(r.timings.attackMs)}, judge ${s(r.timings.judgeMs)}, before ${s(r.timings.beforeMs)}, total ${s(r.timings.totalMs)}`,
          `  cost:   sandbox ~$${sandboxCost.toFixed(5)}; attacker ${r.usage.attacker.calls} call(s) ${r.usage.attacker.input + r.usage.attacker.output} tokens; judge ${r.usage.judge.calls} call(s) ${r.usage.judge.input + r.usage.judge.output} tokens`,
          ...(flag('--log') ? r.log.filter((c) => c.by === 'attacker').map((c) => `  [${c.n}] ${c.tool}${c.actor ? ` as ${c.actor}` : ''}${c.table ? ` ${c.table}` : ''}: ${(c.sql ?? '').replace(/\s+/g, ' ')}\n      -> ${(c.refused ?? c.output).replace(/\s+/g, ' ').slice(0, 300)}`) : []),
        ].join('\n'),
      );
    }
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  console.log('\nfixture  passed  proven  by attacker  agent calls (median)  time (median)  tokens (median)');
  for (const letter of letters) {
    const all = rows[letter]!;
    const proven = all.filter((x) => x.r.status === 'proven');
    console.log(
      [
        letter.padEnd(8),
        `${all.filter((x) => x.ok).length}/${all.length}`.padEnd(7),
        `${proven.length}/${all.length}`.padEnd(7),
        `${proven.filter((x) => x.r.foundBy === 'attacker').length}/${all.length}`.padEnd(12),
        String(median(all.map((x) => agentCalls(x.r)))).padEnd(21),
        s(median(all.map((x) => x.r.timings.totalMs))).padEnd(14),
        String(median(all.map((x) => x.r.usage.attacker.input + x.r.usage.attacker.output + x.r.usage.judge.input + x.r.usage.judge.output))),
      ].join(' '),
    );
  }
  process.exit(failures ? 1 : 0);
};

main().catch((err) => {
  console.error(`prove-fixtures failed: ${(err as Error).message}`);
  process.exit(1);
});
