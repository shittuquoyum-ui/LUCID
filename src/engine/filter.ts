/**
 * What never goes to a model.
 *
 * Before any diff leaves the builder's repo we drop files that teach nothing
 * or might hold secrets (.env, lockfiles, build output, binaries), hide any
 * line that looks like a key or token, and keep only the few files that
 * changed the most.
 *
 * This is a precaution, not a guarantee: a secret in an unusual format can
 * still slip through. The README says so.
 */
import { changedCount, type DiffFile } from './diff';

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface FilterResult {
  files: DiffFile[];
  skipped: SkippedFile[];
  /** How many lines were hidden because they looked like secrets. */
  redacted: number;
}

const SECRET_FILE = /(^|\/)\.env(\.|$)|(^|\/)\.npmrc$|\.pem$|\.key$|(^|\/)id_(rsa|ed25519)/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;
const GENERATED = /(^|\/)(dist|build|out|\.next|\.nuxt|\.vercel|node_modules|coverage|vendor|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.snap$|\.d\.ts$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|bmp|tiff?|mp[34]|mov|webm|wav|ogg|pdf|zip|gz|tgz|rar|7z|woff2?|ttf|otf|eot|exe|dll|so|dylib|wasm|psd|sketch|fig)$/i;

/** Why a file should never be sent, or null when it is fine to send. */
export const skipReason = (f: DiffFile): string | null => {
  if (SECRET_FILE.test(f.path)) return 'may contain secrets';
  if (f.isBinary || BINARY.test(f.path)) return 'binary or media file';
  if (LOCKFILE.test(f.path)) return 'lockfile';
  if (GENERATED.test(f.path)) return 'generated or build output';
  if (f.lines.length === 0) return 'no readable lines';
  return null;
};

const SECRET_LINE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs, incl. Supabase keys
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
  /:\/\/[^\s:/@]+:[^\s@/]{6,}@/, // credentials inside a URL
];

export const looksLikeSecret = (text: string): boolean => SECRET_LINE.some((re) => re.test(text));

export interface FilterOptions {
  /** Most files to keep; the ones with the most changed lines win. */
  maxFiles?: number;
  /** Most lines to keep per file, so one huge file cannot crowd out the rest. */
  maxLinesPerFile?: number;
}

/**
 * Drop unsafe or useless files, hide secret-looking lines, keep the top files.
 * Hidden lines stay in place (line numbers must not shift) but their text is
 * replaced and they can never be quoted.
 */
export const filterDiff = (files: DiffFile[], options: FilterOptions = {}): FilterResult => {
  const { maxFiles = 5, maxLinesPerFile = 300 } = options;
  const skipped: SkippedFile[] = [];
  let redacted = 0;
  const kept: DiffFile[] = [];

  for (const f of files) {
    const reason = skipReason(f);
    if (reason) {
      skipped.push({ path: f.path, reason });
      continue;
    }
    const lines = f.lines.map((l) => {
      if (!looksLikeSecret(l.text)) return l;
      redacted += 1;
      return { ...l, text: '[hidden by Lucid: looked like a secret]', redacted: true };
    });
    kept.push({ ...f, lines });
  }

  const ranked = kept
    .filter((f) => changedCount(f) > 0)
    .sort((a, b) => changedCount(b) - changedCount(a));

  for (const f of ranked.slice(maxFiles)) skipped.push({ path: f.path, reason: 'smaller change than the files sent' });
  for (const f of kept.filter((f) => changedCount(f) === 0)) {
    const reason = f.lines.some((l) => l.status === 'moved') ? 'only moved lines' : 'no added or removed lines';
    skipped.push({ path: f.path, reason });
  }

  const chosen = ranked.slice(0, maxFiles).map((f) =>
    f.lines.length > maxLinesPerFile ? { ...f, lines: f.lines.slice(0, maxLinesPerFile) } : f,
  );

  return { files: chosen, skipped, redacted };
};
