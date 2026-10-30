/**
 * The prover's integration test: runs the real prover (Modal sandbox,
 * Muse Spark attacker, Baseten judge) on the prover-app fixtures.
 *
 *   npm run -s prove:fixtures              all five, a–e
 *   npm run -s prove:fixtures -- a c       some
 *
 * a, b and c must come back "proven" with BEFORE blocked; d and e must not
 * be proven. Exits with 1 when any fixture does not.
 */
import { prove, type ProofResult } from '../src/prover/prove';
import { PROVER_COMMITS, proverCommit, type CommitLetter } from '../test/proverFixtures';

const letters = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROVER_COMMITS)) as CommitLetter[];

// Modal prices (us-east, per second): CPU core and memory GiB. The sandbox has 1 core and 1 GiB.
const CORE_SECOND = 0.0000131;
const GIB_SECOND = 0.00000222;

const passed = (letter: CommitLetter, r: ProofResult) =>
  PROVER_COMMITS[letter].expect === 'proven' ? r.status === 'proven' && r.before === 'blocked' : r.status !== 'proven' && r.status !== 'error';

const main = async () => {
  const results = await Promise.all(
    letters.map(async (letter) => {
      const commit = proverCommit(letter);
      const r = await prove({ before: commit.before, after: commit.after, touched: commit.touched });
      return { letter, r };
    }),
  );
  let failures = 0;
  for (const { letter, r } of results) {
    const ok = passed(letter, r);
    if (!ok) failures += 1;
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const sandboxCost = (r.timings.totalMs / 1000) * (CORE_SECOND + GIB_SECOND);
    console.log(
      [
        `${letter} ${PROVER_COMMITS[letter].file}  ${ok ? 'PASS' : 'FAIL'} (expected ${PROVER_COMMITS[letter].expect})`,
        `  status: ${r.status}${r.action ? `, ${r.role} ${r.action} ${r.rows} row(s) of ${r.table}` : ''}, before: ${r.before}`,
        `  query:  ${r.query ?? '-'}`,
        `  reason: ${r.reason ?? '-'}${r.judge ? `  | judge: ${r.judge.clearlyPublic ? 'public' : 'private'} (${r.judge.reason})` : ''}`,
        `  steps:  ${r.summary}`,
        `  time:   setup ${s(r.timings.setupMs)}, attack ${s(r.timings.attackMs)}, judge ${s(r.timings.judgeMs)}, before ${s(r.timings.beforeMs)}, total ${s(r.timings.totalMs)}`,
        `  cost:   sandbox ~$${sandboxCost.toFixed(5)}; attacker ${r.usage.attacker.calls} call(s) ${r.usage.attacker.input + r.usage.attacker.output} tokens; judge ${r.usage.judge.calls} call(s) ${r.usage.judge.input + r.usage.judge.output} tokens`,
      ].join('\n'),
    );
  }
  process.exit(failures ? 1 : 0);
};

main().catch((err) => {
  console.error(`prove-fixtures failed: ${(err as Error).message}`);
  process.exit(1);
});
