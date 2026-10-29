/**
 * What the `lesson` and `preview` commands share: reading the arguments,
 * fetching the diff, running Lucid and the report lines printed to stderr.
 */
import { readFileSync } from 'node:fs';
import { fetchGitHubDiff, isGitHubUrl } from './engine/diff';
import { runLucid, type LucidReport } from './engine/lucid';
import { isProvider, type Provider } from './engine/model';

const VALUE_FLAGS = new Set(['--provider', '--pick', '--write', '--tag']);

/** The value after `--name`, if given. */
export const flagValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export const runFromArgs = async (args: string[], command: string): Promise<LucidReport> => {
  const providerFlag = (name: string): Provider | undefined => {
    const v = flagValue(args, name);
    if (v === undefined) return undefined;
    if (!isProvider(v)) throw new Error(`--${name} must be fake, meta or baseten (got "${v}")`);
    return v;
  };

  // The first argument that is neither a flag nor a flag's value.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) i += 1;
    else if (!a.startsWith('--')) positional.push(a);
  }
  const target = positional[0];
  if (!target) {
    console.error(`Usage: npm run -s ${command} -- <GitHub PR or commit link | path to .diff | - for stdin> [--provider fake|meta|baseten]`);
    process.exit(1);
  }

  const both = providerFlag('provider');
  const providers = { pick: providerFlag('pick') ?? both, write: providerFlag('write') ?? both };

  if (isGitHubUrl(target)) {
    const { text, source, title } = await fetchGitHubDiff(target);
    return runLucid({ diffText: text, source, title, providers });
  }
  const diffText = readFileSync(target === '-' ? 0 : target, 'utf8');
  return runLucid({ diffText, source: null, title: null, providers });
};

export const reportLines = (report: LucidReport): string[] => {
  const lines = [
    `models: pick=${report.models.pick} write=${report.models.write}`,
    `sent: ${report.sentFiles.join(', ') || '(nothing)'}`,
  ];
  if (report.skippedFiles.length) lines.push(`skipped: ${report.skippedFiles.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
  if (report.redactedLines) lines.push(`hidden as possible secrets: ${report.redactedLines} line(s)`);
  if (report.pick) lines.push(`concept: ${report.pick.concept} (teach=${report.pick.teach}). ${report.pick.why}`);
  for (const a of report.attempts) {
    lines.push(`${a.step} via ${a.provider}: ${a.problems.length ? a.problems.join(' | ') : 'ok'}`);
  }
  if (report.check) {
    const total = report.check.verified.length + report.check.failed.length;
    lines.push(`quotes verified: ${report.check.verified.length}/${total}`);
  }
  if (report.plain) {
    const n = report.plain.problems.length;
    lines.push(`plain English: ${report.plain.passed ? 'passed' : `failed (${n} problem${n === 1 ? '' : 's'})`}`);
  }
  lines.push(timeLine(report.timing));
  lines.push(`outcome: ${report.outcome}`);
  return lines;
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** e.g. "time: pick 8.2s, write 21.5s, total 30.1s"; steps that did not run are left out. */
export const timeLine = (t: LucidReport['timing']): string => {
  const parts = [t.pickMs === null ? null : `pick ${seconds(t.pickMs)}`, t.writeMs === null ? null : `write ${seconds(t.writeMs)}`, `total ${seconds(t.totalMs)}`];
  return `time: ${parts.filter((p) => p !== null).join(', ')}`;
};
