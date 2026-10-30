/**
 * What never goes to a model.
 *
 * Before any diff leaves the builder's repo we drop files that teach nothing
 * or might hold secrets (.env, lockfiles, build output, binaries), mask any
 * value that looks like a key or token (sk_live_abc… -> sk_live••••; the
 * line stays, the value never leaves), and keep only the few files that
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
  /** How many lines had a secret masked or were hidden. */
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

/** A private key block: the whole line is hidden (the key itself follows on other lines). */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Secret values. Only the value is masked, so a card can still point at the
 * line ("the key typed into this file") without ever showing the key. The
 * value is the whole match, or the group named "v".
 */
const SECRET_VALUE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs, incl. Supabase keys
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"`](?<v>[^'"`\s]{8,})['"`]/gi,
  /:\/\/[^\s:/@]+:(?<v>[^\s@/]{6,})@/g, // credentials inside a URL
];

/** What a masked value ends with. */
export const MASK = '••••';
/** Vendor prefixes that say what kind of key it is without giving any of it away. */
const KNOWN_PREFIX = /^(?:sk-(?:proj-|ant-)?|[spr]k_(?:live|test)_|AKIA|gh[pousr]_|github_pat_|xox[abprs]-|AIza|eyJ)/;
const PREFIX_MAX = 7;

/** "sk_live_abc…" -> "sk_live••••". A value with no known prefix keeps nothing. */
export const maskValue = (value: string): string => (value.match(KNOWN_PREFIX)?.[0] ?? '').slice(0, PREFIX_MAX) + MASK;

/** A masked value in a line: a short prefix, then exactly the mask (a run of dots in the app's own text is not one). */
const MASKED = new RegExp(`(?:^|[\\s'"\`=:(,])[^\\s'"\`•]{0,${PREFIX_MAX}}${MASK}(?!•)`);
export const hasMaskedSecret = (text: string): boolean => MASKED.test(text);

/** The line with every secret value masked (unchanged when there is none). */
export const maskSecrets = (text: string): string =>
  SECRET_VALUE.reduce(
    (out, re) =>
      out.replace(re, (match: string, ...rest: unknown[]) => {
        const groups = rest[rest.length - 1];
        const value = typeof groups === 'object' && groups !== null ? (groups as { v?: string }).v : undefined;
        const secret = value ?? match;
        return secret.includes(MASK) ? match : match.replace(secret, maskValue(secret));
      }),
    text,
  );

export const looksLikeSecret = (text: string): boolean => PRIVATE_KEY.test(text) || maskSecrets(text) !== text;

/** What a hidden line shows instead of its text. */
export const HIDDEN_TEXT = '[hidden by Lucid: looked like a secret]';

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
      // Already hidden on the builder's machine: stays hidden, never quotable.
      if (l.text === HIDDEN_TEXT) return { ...l, redacted: true };
      if (PRIVATE_KEY.test(l.text)) {
        redacted += 1;
        return { ...l, text: HIDDEN_TEXT, redacted: true };
      }
      const text = maskSecrets(l.text);
      if (text !== l.text) redacted += 1;
      // Masked here, or already on the builder's machine: quotable as it reads now.
      return hasMaskedSecret(text) ? { ...l, text, masked: true } : l;
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
