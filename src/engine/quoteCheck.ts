/**
 * The quote checker: Lucid's honesty layer.
 *
 * Every line a model quotes must really be in the diff, in the same order,
 * with a status that fits what the quote is used for:
 *
 *   role 'shows'   -> how the app works NOW   -> only added or unchanged lines
 *   role 'removed' -> what this change removed -> only removed lines
 *
 * A removed line can never prove how the app works today. A line hidden as a
 * possible secret can never be quoted. A quote that fails is dropped before
 * the builder sees it. Plain code, no model call.
 */
import { shownLine, type DiffFile, type DiffLine, type DiffSource, type LineStatus } from './diff';
import type { Evidence, Lesson, Quote } from './schemas';

export type Role = 'shows' | 'removed';

export interface Match {
  file: DiffFile;
  lines: DiffLine[];
  /** Line numbers as a reader sees them (old-file numbers for removed lines). */
  start: number;
  end: number;
  /** True when the model's line number was off and we corrected it from the match. */
  lineCorrected: boolean;
}

export type CheckOutcome = { ok: true; match: Match } | { ok: false; reason: string };

/** Collapse whitespace so indentation or spacing differences never cause false failures. */
export const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** Models sometimes copy the listing prefix ("+ 12 | "); strip it before comparing. */
const stripListingPrefix = (s: string): string => s.replace(/^\s*[+\- ]?\s*\d+\s*\|\s?/, '');

const quoteLines = (code: string): string[] =>
  code
    .split('\n')
    .map((l) => normalize(stripListingPrefix(l)))
    .filter((l) => l.length > 0);

/** A quoted line matches a diff line when it is the whole line, or a clear piece of it. */
const lineMatches = (quoted: string, line: DiffLine): boolean => {
  if (line.redacted) return false;
  const actual = normalize(line.text);
  if (actual === quoted) return true;
  return quoted.length >= 10 && actual.includes(quoted);
};

const allowed = (role: Role, status: LineStatus): boolean =>
  role === 'shows' ? status !== 'removed' : status === 'removed';

const findFile = (files: DiffFile[], name: string): DiffFile | string => {
  const exact = files.find((f) => f.path === name || f.oldPath === name);
  if (exact) return exact;
  const clean = name.replace(/^\.?\//, '');
  const suffix = files.filter((f) => f.path.endsWith(`/${clean}`) || f.path === clean);
  if (suffix.length === 1) return suffix[0]!;
  return suffix.length > 1 ? `"${name}" matches more than one file` : `"${name}" is not in this diff`;
};

/**
 * Find where a quote lives. Lines must be consecutive in the version of the
 * file the role refers to: the new file for 'shows', the old file for 'removed'.
 */
export const locate = (files: DiffFile[], file: string, code: string, claimedLine: number, role: Role): CheckOutcome => {
  const target = findFile(files, file);
  if (typeof target === 'string') return { ok: false, reason: target };

  const wanted = quoteLines(code);
  if (wanted.length === 0) return { ok: false, reason: 'the quote is empty' };

  // The version of the file this role reads: new file (no removed lines) or old file (no added lines).
  const view = target.lines.filter((l) => (role === 'shows' ? l.status !== 'removed' : l.status !== 'added'));

  const matches: Match[] = [];
  let wrongStatus = false;
  for (let i = 0; i + wanted.length <= view.length; i += 1) {
    const slice = view.slice(i, i + wanted.length);
    if (!slice.every((line, k) => lineMatches(wanted[k]!, line))) continue;
    if (!slice.every((line) => allowed(role, line.status))) {
      wrongStatus = true;
      continue;
    }
    const start = shownLine(slice[0]!);
    const end = shownLine(slice[slice.length - 1]!);
    matches.push({ file: target, lines: slice, start, end, lineCorrected: start !== claimedLine });
  }

  if (matches.length === 0) {
    // The code may be in the diff, just with the wrong status for this role
    // (e.g. a removed line used to describe the app today). Say so precisely,
    // because this reason is what the model is told when it retries.
    if (!wrongStatus) {
      for (let i = 0; i + wanted.length <= target.lines.length; i += 1) {
        const slice = target.lines.slice(i, i + wanted.length);
        if (slice.every((line, k) => lineMatches(wanted[k]!, line))) {
          wrongStatus = true;
          break;
        }
      }
    }
    if (wrongStatus) {
      return {
        ok: false,
        reason:
          role === 'shows'
            ? 'the quote uses removed lines to describe how the app works now'
            : 'a quote about removed code must only use removed lines',
      };
    }
    // Was it quoting a hidden line?
    if (target.lines.some((l) => l.redacted) && wanted.some((w) => w.includes('hidden by Lucid'))) {
      return { ok: false, reason: 'the quote uses a line hidden as a possible secret' };
    }
    return { ok: false, reason: `the quoted code is not in ${target.path} (as ${role === 'shows' ? 'current' : 'removed'} lines)` };
  }

  // Several identical spots: prefer the one nearest the line the model named.
  matches.sort((a, b) => Math.abs(a.start - claimedLine) - Math.abs(b.start - claimedLine));
  return { ok: true, match: matches[0]! };
};

/** A permanent link to the exact lines on GitHub, or null for local diffs. */
export const lineLink = (source: DiffSource | null, match: Match, role: Role): string | null => {
  if (!source) return null;
  const sha = role === 'shows' ? source.headSha : source.baseSha;
  if (!sha) return null;
  const path = role === 'shows' ? match.file.path : match.file.oldPath ?? match.file.path;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const range = match.end > match.start ? `#L${match.start}-L${match.end}` : `#L${match.start}`;
  return `https://github.com/${source.owner}/${source.repo}/blob/${sha}/${encoded}${range}`;
};

// ---------------------------------------------------------------------------
// Checking whole steps
// ---------------------------------------------------------------------------

export interface VerifiedQuote extends Quote {
  /** Corrected from the diff when the model's number was off. */
  line: number;
  endLine: number;
  /** Path as it appears in the diff (the model may have shortened it). */
  file: string;
  link: string | null;
}

/** A lesson after the quote checker: only verified quotes remain. */
export type CheckedLesson = Lesson & { quotes: VerifiedQuote[] };

export interface FailedItem<T> {
  item: T;
  reason: string;
}

export interface LessonCheck {
  verified: VerifiedQuote[];
  failed: FailedItem<Quote>[];
}

export const checkQuotes = (quotes: Quote[], files: DiffFile[], source: DiffSource | null): LessonCheck => {
  const verified: VerifiedQuote[] = [];
  const failed: FailedItem<Quote>[] = [];
  for (const q of quotes) {
    const outcome = locate(files, q.file, q.code, q.line, q.role);
    if (!outcome.ok) {
      failed.push({ item: q, reason: outcome.reason });
      continue;
    }
    const { match } = outcome;
    verified.push({
      ...q,
      file: match.file.path,
      // Show the real lines from the diff, not the model's retyping of them.
      code: match.lines.map((l) => l.text).join('\n'),
      line: match.start,
      endLine: match.end,
      link: lineLink(source, match, q.role),
    });
  }
  return { verified, failed };
};

export const checkLesson = (lesson: Lesson, files: DiffFile[], source: DiffSource | null): LessonCheck =>
  checkQuotes(lesson.quotes, files, source);

/** Step 1's evidence uses the same rules; its status decides the role. */
export const checkEvidence = (evidence: Evidence[], files: DiffFile[]): FailedItem<Evidence>[] =>
  evidence.flatMap((e) => {
    const outcome = locate(files, e.file, e.code, e.line, e.status === 'removed' ? 'removed' : 'shows');
    return outcome.ok ? [] : [{ item: e, reason: outcome.reason }];
  });
