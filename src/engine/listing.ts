/**
 * How a diff is shown to the model.
 *
 * Each line carries its status marker and the line number a reader would
 * use, so the model can quote `file + line + status + code` and the quote
 * checker can verify all four.
 *
 *   + 12 | const user = await getUser()     added, new-file line 12
 *     13 | return user                      unchanged, new-file line 13
 *   = 14 | if (!user) return null           moved: removed and added back unchanged
 *   -  7 | const user = getUserSync()       removed, OLD-file line 7
 *
 * A moved line is shown once, at its new spot. Its old copy is left out.
 */
import { shownLine, type DiffFile, type DiffLine } from './diff';

const MARKER = { added: '+', removed: '-', unchanged: ' ', moved: '=' } as const;

export const LISTING_LEGEND = [
  'Each line is: <marker> <line number> | <code>',
  "  '+' = added in this change (exists now)",
  "  ' ' = unchanged context (exists now)",
  "  '=' = moved: the same line was removed and added back unchanged (here, or from another file in this change). It is NOT a change; treat it as unchanged context",
  "  '-' = removed in this change (no longer exists; the number is its OLD line number)",
  'Lines shown as [hidden by Lucid: ...] were removed for safety and must never be quoted.',
].join('\n');

const describe = (f: DiffFile): string => {
  if (f.isNew) return ' (new file)';
  if (f.isDeleted) return ' (deleted file)';
  if (f.oldPath && f.oldPath !== f.path) return ` (renamed from ${f.oldPath})`;
  return '';
};

const numbered = (lines: DiffLine[], number: (l: DiffLine) => number, marker?: (l: DiffLine) => string): string => {
  const width = Math.max(...lines.map((l) => String(number(l)).length), 1);
  return lines.map((l) => `${marker ? `${marker(l)} ` : ''}${String(number(l)).padStart(width)} | ${l.text}`).join('\n');
};

export const renderListing = (files: DiffFile[]): string =>
  files
    .map((f) => {
      const shown = f.lines.filter((l) => !(l.status === 'moved' && l.newLine === null));
      return `=== FILE: ${f.path}${describe(f)} ===\n${numbered(shown, shownLine, (l) => MARKER[l.status])}`;
    })
    .join('\n\n');

/**
 * The same change as two plain versions of each file: BEFORE (removed,
 * unchanged and moved lines, old numbers) and AFTER (added, unchanged and
 * moved lines, new numbers). Only the changed parts of each file appear.
 */
export const renderVersions = (files: DiffFile[]): string =>
  files
    .map((f) => {
      const before = f.lines.filter((l) => l.oldLine !== null);
      const after = f.lines.filter((l) => l.newLine !== null);
      return [
        `=== FILE: ${f.path}${describe(f)} ===`,
        '--- BEFORE ---',
        before.length ? numbered(before, (l) => l.oldLine!) : f.isNew ? '(the file did not exist)' : '(nothing)',
        '--- AFTER ---',
        after.length ? numbered(after, (l) => l.newLine!) : f.isDeleted ? '(the file was deleted)' : '(nothing)',
      ].join('\n');
    })
    .join('\n\n');
