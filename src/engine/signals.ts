/**
 * Risk signals: fast pattern checks on the lines a change added or removed.
 *
 * A signal is a hint for the picker ("look at this line"), never a verdict.
 * The picker confirms or rejects each one and may find risks they missed.
 * Each check is tuned so that its everyday safe look-alike stays quiet:
 * a policy that checks the owner, a key used only on the server, a webhook
 * that checks its signature. Plain code, no model call.
 */
import { shownLine, type DiffFile, type DiffLine } from './diff';
import { hasMaskedSecret, HIDDEN_TEXT } from './filter';

export const RISK_CATEGORIES = ['data-exposure', 'secrets', 'auth', 'ownership', 'payments', 'other'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type SignalId =
  | 'rls-disabled'
  | 'policy-dropped'
  | 'policy-allows-all'
  | 'owner-check-removed'
  | 'bucket-made-public'
  | 'secret-in-browser-code'
  | 'service-role-in-browser-code'
  | 'public-env-secret'
  | 'auth-check-removed'
  | 'admin-without-role-check'
  | 'write-without-owner-filter'
  | 'webhook-without-signature-check'
  | 'amount-from-request'
  | 'cors-any-origin'
  | 'table-dropped'
  | 'delete-all';

export interface Signal {
  id: SignalId;
  category: RiskCategory;
  file: string;
  /** The line number a reader sees (old-file number for a removed line). */
  line: number;
  status: 'added' | 'removed';
  code: string;
  /** What the pattern saw, for the picker. */
  hint: string;
}

const CATEGORY: Record<SignalId, RiskCategory> = {
  'rls-disabled': 'data-exposure',
  'policy-dropped': 'data-exposure',
  'policy-allows-all': 'data-exposure',
  'owner-check-removed': 'data-exposure',
  'bucket-made-public': 'data-exposure',
  'secret-in-browser-code': 'secrets',
  'service-role-in-browser-code': 'secrets',
  'public-env-secret': 'secrets',
  'auth-check-removed': 'auth',
  'admin-without-role-check': 'auth',
  'write-without-owner-filter': 'ownership',
  'webhook-without-signature-check': 'payments',
  'amount-from-request': 'payments',
  'cors-any-origin': 'other',
  'table-dropped': 'other',
  'delete-all': 'other',
};

const HINT: Record<SignalId, string> = {
  'rls-disabled': 'row level security is turned off for a table',
  'policy-dropped': 'a database policy is dropped or removed and not created again',
  'policy-allows-all': 'a policy that lets every row through (true)',
  'owner-check-removed': 'a check against the signed-in user (auth.uid()) was removed and not added back',
  'bucket-made-public': 'a storage bucket is set to public',
  'secret-in-browser-code': 'a secret value (masked here) typed into a file that runs in the browser',
  'service-role-in-browser-code': 'the service role (full database access) is used in a file that runs in the browser',
  'public-env-secret': 'a NEXT_PUBLIC_ setting (sent to every browser) named like a secret',
  'auth-check-removed': 'a sign-in check was removed and no other sign-in check was added in this file',
  'admin-without-role-check': 'an admin route or action with no check of the person’s role in the lines shown',
  'write-without-owner-filter': 'an update or delete with no filter on the owner or user',
  'webhook-without-signature-check': 'a webhook handler with no signature check in the lines shown',
  'amount-from-request': 'a price or amount taken from what the browser sent',
  'cors-any-origin': 'any website may call this (Access-Control-Allow-Origin: *)',
  'table-dropped': 'a database table is dropped',
  'delete-all': 'a delete with no condition (every row)',
};

/** Signals in the order the picker should look at them: data exposure first. */
const PRIORITY = RISK_CATEGORIES;

// --- where code runs ---------------------------------------------------------

const BROWSER_PATH = /(^|\/)(app|components|pages|public|client)\/|\.(tsx|jsx)$/;
const SERVER_PATH = /(^|\/)(api|server|actions?|supabase\/functions|scripts|migrations)(\/|\.)|(^|\/)(route|middleware)\.[jt]sx?$|\.server\.[jt]sx?$/;
const SERVER_MARK = /^\s*['"]use server['"]|import\s+['"]server-only['"]/;
const CLIENT_MARK = /^\s*['"]use client['"]/;
const USE_SERVER = /^\s*['"]use server['"]/;

/** The lines of the file as it is now (added, unchanged and moved-in). */
const current = (f: DiffFile): DiffLine[] => f.lines.filter((l) => l.newLine !== null);

/** Does this file run in the browser, as far as the diff can tell? */
export const runsInBrowser = (f: DiffFile): boolean => {
  const now = current(f);
  if (now.some((l) => CLIENT_MARK.test(l.text))) return true;
  if (now.some((l) => SERVER_MARK.test(l.text))) return false;
  return BROWSER_PATH.test(f.path) && !SERVER_PATH.test(f.path);
};

// --- patterns ----------------------------------------------------------------

const RLS_OFF = /\bdisable\s+row\s+level\s+security\b/i;
const DROP_POLICY = /\bdrop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|[\w.]+)/i;
const CREATE_POLICY = /\bcreate\s+policy\s+("[^"]+"|[\w.]+)/i;
const ALLOW_ALL = /\b(?:using|with\s+check)\s*\(\s*true\s*\)/i;
const OWNER_SQL = /\bauth\.uid\(\)/i;
const BUCKET = /\bbuckets?\b/i;
const PUBLIC_TRUE = /\bpublic\b\s*[:=]\s*true\b|insert\s+into\s+storage\.buckets\b.*\btrue\b/i;
const PAGE_PATH = /(^|\/)(app|pages)\//;
const SERVICE_ROLE = /service_role|SERVICE_ROLE|serviceRole/;
const PUBLIC_ENV_SECRET = /\b(NEXT_PUBLIC|VITE|EXPO_PUBLIC)_\w*(SECRET|SERVICE|PRIVATE)\w*/;
const AUTH_CHECK = /\b(getUser|getSession|getServerSession|currentUser|requireAuth|requireUser|auth)\s*\(|if\s*\(\s*!\s*(user|session)\b|redirect\(\s*['"]\/(login|sign-?in)/;
const ROLE_CHECK = /\brole\b|isAdmin|is_admin|requireAdmin|permission/i;
const ADMIN = /admin/i;
const HANDLER = /export\s+(default\s+)?(async\s+)?function|export\s+const\s+\w+\s*=|\.(get|post|put|patch|delete)\s*\(/;
const OWNER_FILTER = /user_?id|owner_?id|\bowner\b|author_?id|created_by|profile_?id|auth\.uid|ctx\.user|session\.user|user\.id/i;
const SUPABASE_WRITE = /\.(update|delete)\s*\(/;
const SIGNATURE = /constructEvent|webhooks\.verify|verifySignature|verifyWebhook|\.verify\s*\(|timingSafeEqual|stripe-signature|svix-signature|x-hub-signature/i;
const WEBHOOK_PATH = /webhook/i;
const READS_BODY = /\.(json|text|formData)\s*\(\s*\)|req\.body|request\.body/;
const AMOUNT = /(?:req\.body|request\.body|\bbody|\binput|parsedInput)\.(price|amount|unit_?amount|unitAmount|total)\b|formData\.get\(\s*['"](price|amount|total)['"]\s*\)/;
const CORS_ANY = /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]|\borigin\s*:\s*['"]\*['"]/i;
const DROP_TABLE = /\bdrop\s+table\b/i;
const DELETE_ALL_SQL = /\bdelete\s+from\s+[\w."]+\s*;|\btruncate\s+(table\s+)?[\w."]+/i;

const policyName = (m: RegExpMatchArray | null): string | null => m?.[1]?.replace(/"/g, '').toLowerCase() ?? null;

// --- the checks --------------------------------------------------------------

export const findSignals = (files: DiffFile[]): Signal[] => {
  const out: Signal[] = [];
  const seen = new Set<string>();
  const add = (id: SignalId, file: DiffFile, l: DiffLine) => {
    const status = l.status === 'removed' ? 'removed' : 'added';
    const line = shownLine(l);
    const key = `${id}|${file.path}|${status}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, category: CATEGORY[id], file: file.path, line, status, code: l.text.trim(), hint: HINT[id] });
  };

  // Policies created anywhere in the change: dropping one of these is a re-create, not a removal.
  const createdPolicies = new Set(
    files.flatMap((f) => f.lines.filter((l) => l.status === 'added').map((l) => policyName(l.text.match(CREATE_POLICY)))).filter((n) => n !== null),
  );

  for (const f of files) {
    const added = f.lines.filter((l) => l.status === 'added' && !l.redacted);
    const removed = f.lines.filter((l) => l.status === 'removed' && !l.redacted);
    const now = current(f);
    const browser = runsInBrowser(f);

    // Data exposure
    for (const l of added) {
      if (RLS_OFF.test(l.text)) add('rls-disabled', f, l);
      const dropped = policyName(l.text.match(DROP_POLICY));
      if (dropped && !createdPolicies.has(dropped)) add('policy-dropped', f, l);
      if (ALLOW_ALL.test(l.text)) add('policy-allows-all', f, l);
      if (PUBLIC_TRUE.test(l.text) && (BUCKET.test(l.text) || now.some((n) => BUCKET.test(n.text)))) add('bucket-made-public', f, l);
    }
    for (const l of removed) {
      const gone = policyName(l.text.match(CREATE_POLICY));
      if (gone && !createdPolicies.has(gone)) add('policy-dropped', f, l);
    }
    if (!added.some((l) => OWNER_SQL.test(l.text))) {
      for (const l of removed) if (OWNER_SQL.test(l.text)) add('owner-check-removed', f, l);
    }

    // Secrets
    if (browser) {
      for (const l of f.lines) {
        if (l.status === 'added' && (l.text === HIDDEN_TEXT || hasMaskedSecret(l.text))) add('secret-in-browser-code', f, l);
      }
      for (const l of added) if (SERVICE_ROLE.test(l.text)) add('service-role-in-browser-code', f, l);
    }
    for (const l of added) if (PUBLIC_ENV_SECRET.test(l.text)) add('public-env-secret', f, l);

    // Auth
    if (!added.some((l) => AUTH_CHECK.test(l.text))) {
      for (const l of removed) if (AUTH_CHECK.test(l.text)) add('auth-check-removed', f, l);
    }
    const adminFile = ADMIN.test(f.path) || added.some((l) => ADMIN.test(l.text) && HANDLER.test(l.text));
    // Something a browser can reach: a route, a page or a server action (not a helper file).
    const routeOrAction = SERVER_PATH.test(f.path) || PAGE_PATH.test(f.path) || now.some((l) => USE_SERVER.test(l.text));
    if (adminFile && routeOrAction) {
      const handler = added.find((l) => HANDLER.test(l.text));
      if (handler && !now.some((l) => ROLE_CHECK.test(l.text))) add('admin-without-role-check', f, handler);
    }

    // Ownership: a database write whose statement (from `.from(` to `;`) has no owner filter.
    for (let i = 0; i < now.length; i += 1) {
      if (!/\.from\(/.test(now[i]!.text)) continue;
      let end = i;
      while (end < now.length - 1 && end - i < 10 && !/;\s*$/.test(now[end]!.text)) end += 1;
      const statement = now.slice(i, end + 1);
      const write = statement.find((l) => SUPABASE_WRITE.test(l.text));
      if (!write || !statement.some((l) => l.status === 'added')) continue;
      if (!statement.some((l) => OWNER_FILTER.test(l.text))) add('write-without-owner-filter', f, write.status === 'added' ? write : statement.find((l) => l.status === 'added')!);
      i = end;
    }

    // Payments
    if (WEBHOOK_PATH.test(f.path) && added.length > 0 && !now.some((l) => SIGNATURE.test(l.text))) {
      add('webhook-without-signature-check', f, added.find((l) => READS_BODY.test(l.text)) ?? added.find((l) => HANDLER.test(l.text)) ?? added[0]!);
    }
    for (const l of added) if (AMOUNT.test(l.text)) add('amount-from-request', f, l);

    // Other
    for (const l of added) {
      if (CORS_ANY.test(l.text)) add('cors-any-origin', f, l);
      if (DROP_TABLE.test(l.text)) add('table-dropped', f, l);
      if (DELETE_ALL_SQL.test(l.text)) add('delete-all', f, l);
    }
  }

  return out.sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
};

/**
 * Policies this change drops and creates again under the same name, where
 * the earlier rule is not shown (no removed `create policy` line for it).
 * The change cannot prove the new rule differs from the old one.
 */
export const recreatedPolicies = (files: DiffFile[]): string[] => {
  const textOf = (status: DiffLine['status']) => files.flatMap((f) => f.lines.filter((l) => l.status === status).map((l) => l.text));
  const names = (lines: string[], re: RegExp) => lines.map((t) => policyName(t.match(re))).filter((n) => n !== null);
  const added = textOf('added');
  const dropped = new Set(names(added, DROP_POLICY));
  const shownBefore = new Set(names(textOf('removed'), CREATE_POLICY));
  return [...new Set(names(added, CREATE_POLICY).filter((n) => dropped.has(n) && !shownBefore.has(n)))];
};

/** A note for every model that reads the change, or null when no rule is re-created. */
export const recreatedNote = (files: DiffFile[]): string | null => {
  const names = recreatedPolicies(files);
  if (!names.length) return null;
  const list = names.map((n) => `"${n}"`).join(', ');
  return [
    `RE-CREATED RULES: this change drops ${list} and creates ${names.length === 1 ? 'it' : 'them'} again under the same name.`,
    'The earlier version is not shown, so nothing here proves the new rule behaves differently from the old one.',
    'Never say it is new or "now" different. At most say what the commit did: it re-creates the rule (for example so the setup can run twice).',
  ].join(' ');
};

/** The signals as hint lines for the picker. */
export const signalsForPrompt = (signals: Signal[]): string =>
  signals.length
    ? signals.map((s) => `- [${s.id}, ${s.category}] ${s.file} line ${s.line} (${s.status}): ${s.code}\n  pattern saw: ${s.hint}`).join('\n')
    : '- none. The pattern checks found nothing, but they are simple: you may still find a risk they missed.';
