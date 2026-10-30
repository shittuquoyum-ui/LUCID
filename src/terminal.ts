/**
 * What the `lesson` and `preview` commands share: reading the arguments,
 * fetching the diff, running Lucid and the report lines printed to stderr.
 */
import { readFileSync } from 'node:fs';
import { fetchGitHubDiff, isGitHubUrl } from './engine/diff';
import { runLucid, type LucidReport } from './engine/lucid';
import { isProvider, type Provider, type Usage } from './engine/model';
import type { Attempt } from './engine/steps';

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
  if (report.signals.length) lines.push(`risk signals: ${report.signals.map((s) => `${s.id} (${s.file}:${s.line})`).join(', ')}`);
  if (report.pick) {
    const p = report.pick;
    const risk = p.kind === 'risk' ? `, ${p.category}, ${p.severity}` : '';
    lines.push(`kind: ${p.kind}${risk}. concept: ${p.concept}. ${p.why}`);
  }
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
  if (report.review) {
    const r = report.review;
    const why = [r.claimsTrue ? null : 'false claims', r.quizOk ? null : 'quiz answered by the story'].filter((x) => x !== null);
    lines.push(`fact check: ${r.passed ? 'passed' : `failed (${why.join(', ') || 'no verdict'})`}`);
  }
  if (report.warningReview) {
    const r = report.warningReview;
    const why = [r.riskShown ? null : 'risk not shown in the change', r.claimsTrue ? null : 'false claims', r.fixOk ? null : 'wrong fix'].filter((x) => x !== null);
    lines.push(`fact check (warning): ${r.passed ? 'passed' : `failed (${why.join(', ') || 'no verdict'})`}, severity ${r.severity}`);
  }
  const calls = (step: Attempt['step']) => report.attempts.filter((a) => a.step === step).length;
  if (report.attempts.length) lines.push(`model calls: pick ${calls('pick')}, write ${calls('write')}, review ${calls('review')}`);
  lines.push(timeLine(report.timing, report.usage));
  lines.push(`outcome: ${report.outcome}`);
  return lines;
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const thousands = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "(5.2k in, 1.1k out, 0.8k reasoning)"; empty when no tokens were counted (fake provider). */
const tokens = (u: Usage | null | undefined): string => {
  if (!u || u.input + u.output === 0) return '';
  return ` (${thousands(u.input)} in, ${thousands(u.output)} out${u.reasoning ? `, ${thousands(u.reasoning)} reasoning` : ''})`;
};

const sum = (all: (Usage | null)[]): Usage =>
  all.reduce<Usage>(
    (acc, u) => (u ? { calls: acc.calls + u.calls, input: acc.input + u.input, output: acc.output + u.output, reasoning: acc.reasoning + u.reasoning } : acc),
    { calls: 0, input: 0, output: 0, reasoning: 0 },
  );

/**
 * e.g. "time: pick 8.2s (5.2k in, 0.4k out), write 21.5s (...), review 6.0s (...), total 36.1s (...)".
 * Steps that did not run are left out.
 */
export const timeLine = (t: LucidReport['timing'], usage?: LucidReport['usage']): string => {
  const parts = [
    t.pickMs === null ? null : `pick ${seconds(t.pickMs)}${tokens(usage?.pick)}`,
    t.writeMs === null ? null : `write ${seconds(t.writeMs)}${tokens(usage?.write)}`,
    t.reviewMs === null ? null : `review ${seconds(t.reviewMs)}${tokens(usage?.review)}`,
    `total ${seconds(t.totalMs)}${usage ? tokens(sum([usage.pick, usage.write, usage.review])) : ''}`,
  ];
  return `time: ${parts.filter((p) => p !== null).join(', ')}`;
};
