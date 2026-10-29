/**
 * Run Lucid on one change from the terminal.
 *
 *   npm run -s lesson -- https://github.com/owner/repo/pull/12
 *   npm run -s lesson -- https://github.com/owner/repo/commit/abc1234
 *   npm run -s lesson -- path/to/change.diff
 *   git diff | npm run -s lesson -- -
 *
 * Options:
 *   --provider fake|meta|baseten   use one provider for both steps
 *   --pick <provider>              provider for the concept picker
 *   --write <provider>             provider for the lesson writer
 *   --card                         print the lesson card as JSON
 *   --json                         print the full report as JSON
 *
 * The comment (or card) goes to stdout; the report (what was sent, skipped,
 * checked) goes to stderr, so `> lesson.md` captures just the comment.
 */
import { toCard } from './engine/card';
import { reportLines, runFromArgs } from './terminal';

const args = process.argv.slice(2);

const main = async () => {
  const report = await runFromArgs(args, 'lesson');

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const line of reportLines(report)) console.error(line);
  console.error('');

  if (args.includes('--card')) {
    const card = toCard(report);
    if (card) console.log(JSON.stringify(card, null, 2));
    return;
  }
  if (report.comment) console.log(report.comment);
};

main().catch((err) => {
  console.error(`Lucid failed: ${(err as Error).message}`);
  process.exit(1);
});
