/**
 * The red-team evaluation: every commit goes through what a builder gets
 * (risk signals, picker, writer, fact check), then the prover. Each commit
 * has a known truth; the report says how Lucid did against it.
 *
 *   npm run eval                       every commit; writes samples/eval/eval-report.md
 *   npm run eval -- --only rls-off,e   some, by id
 *   npm run eval -- --concurrency 4    how many at once (default 4)
 *   npm run eval -- --out some/dir     where the report goes
 *   npm run eval -- --generate         have Muse Spark write any fresh commit that does not exist yet
 *   npm run eval -- --regenerate       have it write all of them again
 *   npm run eval:modal                 the same on Modal, in the server's image
 *
 * It needs the model keys and Modal, and it spends real tokens: about a
 * million for a full run. Fresh commits are generated once and kept in
 * test/fixtures/eval-generated, so runs are on the same set.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { proveRequest, wantsProof, type CommitFiles } from '../extension/src/prove';
import { toCard } from '../src/engine/card';
import { parseDiff } from '../src/engine/diff';
import { runLucid } from '../src/engine/lucid';
import { callModel, modelName } from '../src/engine/model';
import { parseWith } from '../src/engine/json';
import { alarms, renderReport, summarize, type EvalProof, type EvalRow, type Prices } from '../src/eval/report';
import { prove, type ProofResult } from '../src/prover/prove';
import type { SetupFile } from '../src/prover/setupFiles';
import { z } from 'zod';
import { evalCommits, GENERATED_DIR, type EvalCommit, type GeneratedCommit } from '../test/evalCommits';
import { baseFiles } from '../test/proverFixtures';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = value('--out') ?? join('samples', 'eval');
const CONCURRENCY = Number(value('--concurrency') ?? 4);
const ONLY = value('--only')?.split(',');
const WHERE = value('--where') ?? 'From a laptop, with sandboxes on Modal';

/**
 * Rough prices, per million tokens: $1.25 in and $4.25 out is what price
 * trackers list for Muse Spark 1.3 on Meta's API and Muse Spark Open on
 * Baseten (not read off either provider's own price page). Modal's 1 CPU and
 * 1 GiB per second, as in scripts/prove-fixtures.ts.
 */
const PRICES: Prices = {
  pickReview: { input: 1.25, output: 4.25 },
  writeAttack: { input: 1.25, output: 4.25 },
  sandboxPerSecond: 0.0000131 + 0.00000222,
};
const PRICE_NOTE = 'both models at $1.25 per million input tokens and $4.25 per million output, the rate price trackers list (not taken from Meta\'s or Baseten\'s own price pages), and sandboxes at Modal\'s per-second rate. Treat it as an order of magnitude.';

// --- fresh commits ---------------------------------------------------------------
// The label starts as what was asked for. The model does not always write that,
// so a person reads every generated commit and corrects its file (see auditNote).
// A regenerated commit needs reading again.

const BRIEFS: Omit<GeneratedCommit, 'model' | 'title' | 'files'>[] = [
  { id: 'gen-orders-any-user', label: 'risky', provable: true, what: 'read rule lets any signed-in user see every order', description: 'A Supabase migration that adds an orders table for a shop (who bought it, the item, the amount, the shipping address). Row level security is on, but the read rule lets any signed-in user see every order.' },
  { id: 'gen-messages-definer', label: 'risky', provable: true, what: 'security definer function reads other people\'s messages', description: 'A Supabase migration that adds a private messages table with owner-only rules, plus a Postgres function the app calls to fetch all messages for a given user id. The function runs with its owner\'s rights and never checks who is calling.' },
  { id: 'gen-profile-update-route', label: 'risky', provable: false, what: 'update with no owner check', description: 'A Next.js API route that updates a row in the profiles table, using an id taken from the request body. It never checks that the id belongs to the signed-in person.' },
  { id: 'gen-stripe-key-in-browser', label: 'risky', provable: false, what: 'secret key in browser code', description: 'A React client component with a checkout button. It creates a Stripe client right in the component, with the secret key typed straight into the file.' },
  { id: 'gen-tasks-owner-rules', label: 'safe', provable: false, what: 'new table with owner-only rules', description: 'A Supabase migration that adds a tasks table. Row level security is on, with rules so each person can only read, add, change and delete their own tasks.' },
  { id: 'gen-public-catalog', label: 'safe', provable: false, what: 'genuinely public table', description: 'A Supabase migration that adds a products table for a public catalog (name, description, price). There is no user data in it. Everyone may read it, and no one may write to it through the app.' },
  { id: 'gen-admin-route-checked', label: 'safe', provable: false, what: 'server-only key behind a role check', description: 'A Next.js API route that lists all users for the admin dashboard. It runs on the server, uses the service role key from the environment, and first checks that the signed-in person has the admin role, refusing anyone else.' },
  { id: 'gen-webhook-verified', label: 'safe', provable: false, what: 'verified webhook', description: 'A Next.js Stripe webhook route that verifies the signature with the webhook secret from the environment before it reads the event, then marks the order as paid.' },
  // Held out: written after the prompts and signals were frozen, in shapes they never mention. Never tuned on.
  { id: 'held-ticket-reassign', label: 'risky', provable: true, heldOut: true, what: 'update rule lets a row be handed to someone else', description: 'A Supabase migration that adds a support tickets table with an owner, a subject and details. People can read, add and change their own tickets, but the update rule puts no limit on what the row may look like afterwards, so its owner can be changed to anyone.' },
  { id: 'held-team-join', label: 'risky', provable: true, heldOut: true, what: 'anyone can join any team, then read its documents', description: 'A Supabase migration that adds teams, team members and team documents. Team documents can be read by members of that team, which is checked properly. But any signed-in person may add themselves to the members table of any team.' },
  { id: 'held-note-wipe-function', label: 'risky', provable: true, heldOut: true, what: 'function deletes another person\'s notes', description: 'A Supabase migration that adds a Postgres function the settings page calls to clear all of a person\'s notes, given their user id. It runs with its owner\'s rights and never checks who is calling.' },
  { id: 'held-metadata-admin', label: 'risky', provable: false, heldOut: true, what: 'read rule trusts a role people can set on themselves', description: 'A Supabase migration that adds a read rule on the notes table so admins can see every note. It decides who is an admin from user_metadata in the sign-in token, which people can edit themselves.' },
  { id: 'held-notes-count-function', label: 'safe', provable: false, heldOut: true, what: 'function returns only a total', description: 'A Supabase migration that adds a Postgres function the home page calls to show how many notes exist in the whole app. It runs with its owner\'s rights and returns one number, nothing else.' },
  { id: 'held-team-owner-invites', label: 'safe', provable: false, heldOut: true, what: 'only a team\'s owner can add members', description: 'A Supabase migration that adds teams, team members and team documents. Team documents can be read by members of that team. Only the owner of a team may add people to it.' },
];

const GenerateSchema = z.object({
  title: z.string().min(1).max(120),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().min(1).max(8000) })).min(1).max(3),
});

const GENERATE_SYSTEM = `You write one small, realistic git commit for a test set. A developer in a hurry wrote it. Write exactly what the description says, no more and no less: if it describes a mistake, make that mistake; if it describes careful code, be careful.

Rules:
- Real, working code, 5 to 40 lines per file. Next.js and TypeScript for app code, Supabase Postgres SQL for migrations.
- No comments that point out a problem or praise the code, and nothing like "TODO", "insecure" or "unsafe". The commit message says what the commit is for, not whether it is safe.
- Migrations go in supabase/migrations/ and build on the existing database you are shown. Do not re-create what exists.
- Never write a realistic secret. Where a key must be typed in, write exactly sk_live_fakekeyfortests.

Answer with JSON only, no other text:
{ "title": "the commit message", "files": [ { "path": "path/to/file", "content": "the whole file" } ] }`;

const generate = async (all: boolean) => {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const schema = baseFiles().map((f) => f.text).join('\n');
  for (const brief of BRIEFS.filter((b) => all || !existsSync(join(GENERATED_DIR, `${b.id}.json`)))) {
    let problems: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const note = problems.length ? `\n\nYOUR LAST ANSWER WAS REJECTED: ${problems.join('; ')}` : '';
      const text = await callModel('meta', { system: GENERATE_SYSTEM, user: `THE EXISTING DATABASE:\n${schema}\n\nTHE COMMIT:\n${brief.description}${note}`, effort: 'low', maxTokens: 6000 });
      const parsed = parseWith(GenerateSchema, text);
      if (!parsed.ok) {
        problems = parsed.problems;
        continue;
      }
      const commit: GeneratedCommit = { ...brief, model: modelName('meta'), title: parsed.value.title, files: parsed.value.files.map((f) => ({ path: f.path, text: f.content })) };
      writeFileSync(join(GENERATED_DIR, `${brief.id}.json`), `${JSON.stringify(commit, null, 2)}\n`);
      console.log(`generated ${brief.id}: ${commit.title}`);
      break;
    }
  }
};

// --- one commit ------------------------------------------------------------------

const asFiles = (files: SetupFile[]): CommitFiles => ({
  paths: async () => files.map((f) => f.path),
  read: async (path) => files.find((f) => f.path === path)!.text,
});

const proofRow = (r: ProofResult): EvalProof => ({
  status: r.status,
  foundBy: r.foundBy,
  before: r.before,
  action: r.action,
  role: r.role,
  table: r.table,
  query: r.query,
  reason: r.reason,
  agentCalls: r.log.filter((c) => c.by === 'attacker').length,
  ms: r.timings.totalMs,
  usage: r.usage,
});

const runOne = async (c: EvalCommit): Promise<EvalRow> => {
  const base = { id: c.id, label: c.label, what: c.what, source: c.source, provable: c.provable };
  try {
    const started = Date.now();
    const report = await runLucid({ diffText: c.diff, source: null, title: c.title, providers: { pick: 'baseten', write: 'meta' }, kinds: ['risk', 'lesson'] });
    const warningMs = Date.now() - started;
    const card = toCard(report);
    const wanted = wantsProof(card);
    // The extension's own request: a commit that changed no setup file gets no sandbox.
    const request = c.setup ? await proveRequest(parseDiff(c.diff), asFiles(c.setup.after), asFiles(c.setup.before)) : null;
    const proof = request ? proofRow(await prove(request, { attacker: 'meta', judge: 'baseten' })) : null;
    const factCheck = report.pick?.kind === 'risk' ? (report.outcome === 'warning' ? 'passed' : 'dropped') : report.review ? (report.review.passed ? 'passed' : 'failed') : null;
    return {
      ...base,
      error: null,
      outcome: report.outcome,
      warned: card?.kind === 'risk',
      category: report.pick?.category ?? null,
      severity: report.severity,
      factCheck,
      gated: wanted && request !== null,
      proof,
      warningMs,
      usage: report.usage,
    };
  } catch (err) {
    const e = err as { name?: string; status?: number };
    // Kind and status only: some services echo part of a key in their messages.
    return { ...base, error: `${e?.name ?? 'Error'}${e?.status ? ` ${e.status}` : ''}`, outcome: 'run-failed', warned: false, category: null, severity: null, factCheck: null, gated: false, proof: null, warningMs: 0, usage: { pick: null, write: null, review: null } };
  }
};

const inPool = async <T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
};

const main = async () => {
  if (args.includes('--generate') || args.includes('--regenerate')) await generate(args.includes('--regenerate'));
  const commits = evalCommits().filter((c) => !ONLY || ONLY.includes(c.id));
  if (!commits.length) throw new Error('no commits to run');
  console.log(`${commits.length} commits, ${CONCURRENCY} at a time`);
  const rows = await inPool(commits, CONCURRENCY, async (c) => {
    const r = await runOne(c);
    console.log(`${c.id}: ${r.error ? `FAILED ${r.error}` : `${r.outcome}, warned ${r.warned ? 'yes' : 'no'}, proof ${r.proof?.status ?? '-'}${r.proof?.foundBy ? ` by ${r.proof.foundBy}` : ''}`}`);
    return r;
  });

  const summary = summarize(rows, PRICES);
  const gitSha = value('--sha') ?? (() => {
    try {
      return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return 'unknown';
    }
  })();
  const report = renderReport(rows, PRICES, {
    date: new Date().toISOString().slice(0, 10),
    gitSha,
    models: `${modelName('baseten')} (pick, fact check, judge), ${modelName('meta')} (write, attack)`,
    where: WHERE,
    concurrency: CONCURRENCY,
    priceNote: PRICE_NOTE,
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'eval-report.md'), report);
  writeFileSync(join(OUT, 'eval-results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  console.log(`\nwarnings on risky ${summary.risky.caught}/${summary.risky.total}, false warnings ${summary.safe.warned}/${summary.safe.total}, proofs in the product ${summary.proofs.inProduct}/${summary.proofs.provable}, prover alone ${summary.proofs.proverAlone}/${summary.proofs.provable} (${summary.proofs.byProbe} probe, ${summary.proofs.byAttacker} attacker), false proofs ${summary.proofs.falseProofsInProduct.length} + ${summary.proofs.falseProofsProverAlone.length}`);
  for (const line of alarms(summary)) console.log(line);
  console.log(`report: ${join(OUT, 'eval-report.md')}`);
  process.exit(0);
};

main().catch((err) => {
  console.error(`eval failed: ${(err as Error).message}`);
  process.exit(1);
});
