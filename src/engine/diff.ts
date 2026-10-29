/**
 * Reading a diff.
 *
 * A unified diff (what `git diff` prints and GitHub serves) lists each changed
 * file, then "hunks" of lines. Every line starts with one marker:
 *   '+' added   (exists only in the new version)
 *   '-' removed (existed only in the old version)
 *   ' ' unchanged context (exists in both)
 *
 * We keep every line's status and BOTH line numbers, because the quote
 * checker needs them: a claim about how the app works now may only rest on
 * lines that exist now (added or unchanged), and a link to a removed line has
 * to point at the old version of the file.
 */

export type LineStatus = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  status: LineStatus;
  text: string;
  /** Line number in the old file; null for added lines. */
  oldLine: number | null;
  /** Line number in the new file; null for removed lines. */
  newLine: number | null;
  /** Set by the filter when the line looked like a secret. Never quotable. */
  redacted?: boolean;
}

export interface DiffFile {
  /** Path in the new version (or the old one, for a deleted file). */
  path: string;
  /** Path in the old version, when it differs (renames) or the file was deleted. */
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  lines: DiffLine[];
}

/** Where the diff came from, so quotes can link to exact lines on GitHub. */
export interface DiffSource {
  owner: string;
  repo: string;
  /** Commit the new lines live in (PR head, or the commit itself). */
  headSha: string;
  /** Commit the old lines live in (PR base, or the commit's parent). */
  baseSha: string | null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const stripPrefix = (p: string): string | null => {
  const trimmed = p.trim().split('\t')[0] ?? '';
  if (trimmed === '/dev/null') return null;
  return trimmed.replace(/^[ab]\//, '');
};

/** Parse unified diff text into files and lines. Pure: no network, no I/O. */
export const parseDiff = (text: string): DiffFile[] => {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  // Lines still expected in the current hunk. While either is above zero,
  // a line starting with '---' or '+++' is content, not a file header.
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (path: string): DiffFile => {
    const f: DiffFile = { path, oldPath: null, isNew: false, isDeleted: false, isBinary: false, lines: [] };
    files.push(f);
    return f;
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const inHunk = oldLeft > 0 || newLeft > 0;

    if (!inHunk) {
      if (line.startsWith('diff --git ')) {
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        file = startFile(m?.[2] ?? line.slice(11));
        if (m && m[1] !== m[2]) file.oldPath = m[1] ?? null;
        continue;
      }
      if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (!file) file = startFile(p ?? '');
        if (p === null) file.isNew = true;
        else if (p !== file.path) file.oldPath = p;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (!file) file = startFile(p ?? '');
        if (p === null) {
          file.isDeleted = true;
          file.oldPath = file.oldPath ?? file.path;
        } else {
          file.path = p;
        }
        continue;
      }
      if (file && line.startsWith('new file mode')) { file.isNew = true; continue; }
      if (file && line.startsWith('deleted file mode')) { file.isDeleted = true; continue; }
      if (file && line.startsWith('rename from ')) { file.oldPath = line.slice(12); continue; }
      if (file && line.startsWith('rename to ')) { file.path = line.slice(10); continue; }
      if (file && (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))) {
        file.isBinary = true;
        continue;
      }
    }

    const hunk = line.match(HUNK);
    if (hunk && file) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }

    if (!file || !inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const marker = line[0];
    const body = line.slice(1);
    if (marker === '+') {
      file.lines.push({ status: 'added', text: body, oldLine: null, newLine: newNo });
      newNo += 1;
      newLeft -= 1;
    } else if (marker === '-') {
      file.lines.push({ status: 'removed', text: body, oldLine: oldNo, newLine: null });
      oldNo += 1;
      oldLeft -= 1;
    } else {
      // ' ' context, or an empty line some tools emit for blank context.
      file.lines.push({ status: 'unchanged', text: body, oldLine: oldNo, newLine: newNo });
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }

  if (file && file.isDeleted && file.oldPath) file.path = file.oldPath;
  return files;
};

/** The line number a reader sees: new-file number, or old-file number for removed lines. */
export const shownLine = (l: DiffLine): number => (l.status === 'removed' ? l.oldLine : l.newLine) ?? 0;

/** How many lines a file actually changed (added + removed). */
export const changedCount = (f: DiffFile): number =>
  f.lines.filter((l) => l.status !== 'unchanged').length;

// ---------------------------------------------------------------------------
// Fetching from GitHub
// ---------------------------------------------------------------------------

export interface FetchedDiff {
  text: string;
  source: DiffSource | null;
  title: string | null;
}

const githubHeaders = (accept: string): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'lucid-agent',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const getJson = async (url: string): Promise<any> => {
  const res = await fetch(url, { headers: githubHeaders('application/vnd.github+json') });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const getDiff = async (url: string): Promise<string> => {
  const res = await fetch(url, { headers: githubHeaders('application/vnd.github.diff') });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
};

const PR_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const COMMIT_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/i;

/** True when the string looks like a GitHub pull request or commit link. */
export const isGitHubUrl = (s: string): boolean => PR_URL.test(s) || COMMIT_URL.test(s);

/**
 * Fetch a pull request's or a commit's diff from GitHub, with the two commits
 * its lines live in. Public repos work without a token; a token only raises
 * the rate limit (and is needed for private repos).
 */
export const fetchGitHubDiff = async (url: string): Promise<FetchedDiff> => {
  const pr = url.match(PR_URL);
  if (pr) {
    const [, owner, repo, num] = pr as [string, string, string, string];
    const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`;
    const [meta, text] = await Promise.all([getJson(api), getDiff(api)]);
    return {
      text,
      title: meta.title ?? null,
      source: { owner, repo, headSha: meta.head.sha, baseSha: meta.base.sha },
    };
  }
  const commit = url.match(COMMIT_URL);
  if (commit) {
    const [, owner, repo, sha] = commit as [string, string, string, string];
    const api = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
    const [meta, text] = await Promise.all([getJson(api), getDiff(api)]);
    return {
      text,
      title: (meta.commit?.message ?? '').split('\n')[0] || null,
      source: { owner, repo, headSha: meta.sha, baseSha: meta.parents?.[0]?.sha ?? null },
    };
  }
  throw new Error(`Not a GitHub pull request or commit link: ${url}`);
};
