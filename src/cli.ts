/**
 * Run Lucid on one change from the terminal.
 *
 *   npm run lesson -- https://github.com/owner/repo/pull/12
 *   npm run lesson -- https://github.com/owner/repo/commit/abc1234
 *   npm run lesson -- path/to/change.diff
 *   git diff | npm run lesson -- -
 *
 * Options:
 *   --provider fake|meta|baseten   use one provider for both steps
 *   --pick <provider>              provider for the concept picker
 *   --write <provider>             provider for the lesson writer
 *   --json                         print the full report as JSON
 *
 * The comment goes to stdout; the report (what was sent, skipped, checked)
 * goes to stderr, so `> lesson.md` captures just the comment.
 */
import { readFileSync } from 'node:fs';
import { fetchGitHubDiff, isGitHubUrl } from './engine/diff';
import { runLucid } from './engine/lucid';
import { isProvider, type Provider } from './engine/model';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const providerFlag = (name: string): Provider | undefined => {
  const v = flag(name);
  if (v === undefined) return undefined;
  if (!isProvider(v)) throw new Error(`--${name} must be fake, meta or baseten (got "${v}")`);
  return v;
};

// The first argument that is neither a flag nor a flag's value.
const VALUE_FLAGS = new Set(['--provider', '--pick', '--write']);
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  if (VALUE_FLAGS.has(a)) i += 1;
  else if (!a.startsWith('--')) positional.push(a);
}
const target = positional[0];

const main = async () => {
  if (!target) {
    console.error('Usage: npm run lesson -- <GitHub PR or commit link | path to .diff | - for stdin> [--provider fake|meta|baseten]');
    process.exit(1);
  }
  const both = providerFlag('provider');
  const providers = { pick: providerFlag('pick') ?? both, write: providerFlag('write') ?? both };

  let diffText: string;
  let source = null;
  let title: string | null = null;
  if (isGitHubUrl(target)) {
    const fetched = await fetchGitHubDiff(target);
    ({ text: diffText, source, title } = fetched);
  } else {
    diffText = readFileSync(target === '-' ? 0 : target, 'utf8');
  }

  const report = await runLucid({ diffText, source, title, providers });

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const log = (s = '') => console.error(s);
  log(`models: pick=${report.models.pick} write=${report.models.write}`);
  log(`sent: ${report.sentFiles.join(', ') || '(nothing)'}`);
  if (report.skippedFiles.length) log(`skipped: ${report.skippedFiles.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
  if (report.redactedLines) log(`hidden as possible secrets: ${report.redactedLines} line(s)`);
  if (report.pick) log(`concept: ${report.pick.concept} (teach=${report.pick.teach}). ${report.pick.why}`);
  for (const a of report.attempts) {
    log(`${a.step} via ${a.provider}: ${a.problems.length ? a.problems.join(' | ') : 'ok'}`);
  }
  if (report.check) {
    const total = report.check.verified.length + report.check.failed.length;
    log(`quotes verified: ${report.check.verified.length}/${total}`);
  }
  log(`outcome: ${report.outcome}`);
  log('');
  if (report.comment) console.log(report.comment);
};

main().catch((err) => {
  console.error(`Lucid failed: ${(err as Error).message}`);
  process.exit(1);
});
