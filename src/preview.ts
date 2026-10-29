/**
 * See a lesson card in the browser. Same arguments as the lesson command:
 *
 *   npm run -s preview -- https://github.com/owner/repo/commit/abc1234 --pick baseten --write meta
 *
 * Writes samples/preview.html (the card page) and samples/card.json (the card
 * data), prints the report to stderr and the page's path to stdout.
 * `--tag 2` writes samples/preview-2.html and samples/card-2.json instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCard } from './engine/card';
import { flagValue, reportLines, runFromArgs } from './terminal';
import { renderCardHtml } from './ui/cardHtml';

const main = async () => {
  const args = process.argv.slice(2);
  const tag = flagValue(args, 'tag');
  if (tag !== undefined && !/^[\w-]+$/.test(tag)) throw new Error('--tag may only use letters, digits, "-" and "_"');
  const suffix = tag ? `-${tag}` : '';

  const report = await runFromArgs(args, 'preview');
  for (const line of reportLines(report)) console.error(line);

  const card = toCard(report);
  if (!card) {
    console.error('No lesson, so no preview was written.');
    return;
  }

  const dir = fileURLToPath(new URL('../samples/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const page = join(dir, `preview${suffix}.html`);
  writeFileSync(page, renderCardHtml(card), 'utf8');
  writeFileSync(join(dir, `card${suffix}.json`), `${JSON.stringify(card, null, 2)}\n`, 'utf8');
  console.log(page);
};

main().catch((err) => {
  console.error(`Lucid failed: ${(err as Error).message}`);
  process.exit(1);
});
