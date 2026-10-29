/**
 * How a diff is shown to the model.
 *
 * Each line carries its status marker and the line number a reader would
 * use, so the model can quote `file + line + status + code` and the quote
 * checker can verify all four.
 *
 *   + 12 | const user = await getUser()     added, new-file line 12
 *     13 | return user                      unchanged, new-file line 13
 *   -  7 | const user = getUserSync()       removed, OLD-file line 7
 */
import { shownLine, type DiffFile } from './diff';

const MARKER = { added: '+', removed: '-', unchanged: ' ' } as const;

export const LISTING_LEGEND = [
  'Each line is: <marker> <line number> | <code>',
  "  '+' = added in this change (exists now)",
  "  ' ' = unchanged context (exists now)",
  "  '-' = removed in this change (no longer exists; the number is its OLD line number)",
  'Lines shown as [hidden by Lucid: ...] were removed for safety and must never be quoted.',
].join('\n');

const describe = (f: DiffFile): string => {
  if (f.isNew) return ' (new file)';
  if (f.isDeleted) return ' (deleted file)';
  if (f.oldPath && f.oldPath !== f.path) return ` (renamed from ${f.oldPath})`;
  return '';
};

export const renderListing = (files: DiffFile[]): string =>
  files
    .map((f) => {
      const width = Math.max(...f.lines.map((l) => String(shownLine(l)).length), 1);
      const body = f.lines
        .map((l) => `${MARKER[l.status]} ${String(shownLine(l)).padStart(width)} | ${l.text}`)
        .join('\n');
      return `=== FILE: ${f.path}${describe(f)} ===\n${body}`;
    })
    .join('\n\n');
