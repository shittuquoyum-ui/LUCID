/**
 * The Lucid prover: build the builder's database twice in a disposable
 * sandbox (as it was before the commit, and after it), fill it with two fake
 * users, and try to reach Alice's rows as a signed-out visitor or as Bob.
 *
 * "proven" means exactly this: Lucid reproduced unauthorized access against
 * fake users, using the builder's database rules, in a disposable sandbox.
 * It never means real data was exposed. When the attack fails, the result is
 * "not-reproduced", which is never a safety claim.
 *
 * Order, to keep a proof under about 90 seconds:
 *   start the sandbox -> build AFTER -> seed -> attack (probes on the
 *   commit's tables first, then the attacker model). Each hit the ground
 *   truth confirms is weighed as it comes: a read of clearly public data is
 *   no proof (the judge); then the exact query runs again on BEFORE (built
 *   the first time it is needed). The first hit that BEFORE blocked wins:
 *   "blocked before this commit, leaked after". If every hit was already
 *   open before, the first of those is the proof ("before: also open").
 *   The sandbox is destroyed at the end, always.
 */
import { z } from 'zod';
import { parseWith } from '../engine/json';
import { callModel, emptyUsage, type Provider, type Usage } from '../engine/model';
import { prompt } from '../engine/prompts';
import { attack, canaryRowsIn, changesBetween, runAs, type Evidence, type ToolCall } from './attack';
import { downgrade, judgePrivacy, type Verdict } from './judge';
import type { BeforeState, ProofResult, ProofStatus } from './result';
import { modalSandbox, type Sandbox } from './sandbox';
import {
  INTROSPECT_SQL,
  makeFakeUsers,
  parseSeedCheck,
  parseSnapshot,
  parseTables,
  seedCheckSql,
  seedSql,
  seedTargets,
  snapshotSql,
  USERS_SQL,
  type FakeUsers,
  type SeedTarget,
  type TableInfo,
} from './schema';
import { orderSetupFiles, type SetupFile, type Touched } from './setupFiles';
import { CLUSTER_SHIM, DATABASE_SHIM } from './shim';
import { isRefusal, prepareSetupSql } from './sqlSafety';

export { PROOF_STATEMENT, type BeforeState, type ProofResult, type ProofStatus } from './result';

export interface ProveInput {
  before: SetupFile[];
  after: SetupFile[];
  touched: Touched;
}

export interface ProveOptions {
  sandbox?: () => Sandbox;
  attacker?: Provider;
  judge?: Provider;
  /** The whole proof stops starting new work after this long. */
  budgetMs?: number;
  users?: FakeUsers;
}

const joined = (files: SetupFile[]) => orderSetupFiles(files).map((f) => `-- file: ${f.path}\n${f.text}`).join('\n\n');

const summarize = (log: ToolCall[], evidence: Evidence | null): string => {
  const probes = log.filter((c) => c.by === 'probe').length;
  const attacker = log.filter((c) => c.by === 'attacker').length;
  const refused = log.filter((c) => c.refused).length;
  const who = evidence ? (evidence.actor === 'anon' ? 'a signed-out visitor' : 'Bob') : null;
  const what = evidence ? { read: `read ${evidence.rows} of Alice's rows`, update: `changed Alice's rows`, delete: `deleted ${evidence.rows} of Alice's rows` }[evidence.action] : null;
  return [
    `${probes} standard probe${probes === 1 ? '' : 's'}, ${attacker} attacker call${attacker === 1 ? '' : 's'}${refused ? ` (${refused} refused)` : ''}.`,
    evidence ? `${who} ${what} in ${evidence.table}.` : "No query reached Alice's rows.",
  ].join(' ');
};

const SeedSchema = z.object({ sql: z.string().min(1).max(20_000) });

export const prove = async (input: ProveInput, options: ProveOptions = {}): Promise<ProofResult> => {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? 90_000);
  const attacker = options.attacker ?? 'meta';
  const judgeProvider = options.judge ?? 'baseten';
  const users = options.users ?? makeFakeUsers();
  const usage = { attacker: emptyUsage(), judge: emptyUsage() };
  const timings = { setupMs: 0, attackMs: 0, judgeMs: 0, beforeMs: 0, totalMs: 0 };
  let log: ToolCall[] = [];

  const result = (r: Partial<ProofResult> & { status: ProofStatus }): ProofResult => ({
    table: null,
    role: null,
    action: null,
    rows: 0,
    query: null,
    before: 'not-run',
    reason: null,
    judge: null,
    summary: summarize(log, null),
    log,
    usage,
    ...r,
    timings: { ...timings, totalMs: Date.now() - started },
  });

  const afterSql = prepareSetupSql(joined(input.after));
  if (isRefusal(afterSql)) return result({ status: 'error', reason: afterSql.reason });
  if (!afterSql.sql.trim()) return result({ status: 'error', reason: 'no database setup files were sent' });

  const sandbox = (options.sandbox ?? modalSandbox)();
  let beforeBuilt: { tables: TableInfo[]; targets: SeedTarget[] } | 'error' | null = null;
  try {
    await sandbox.start();
    await sandbox.psql({ db: 'postgres', user: 'postgres', sql: `${CLUSTER_SHIM}\ncreate database after;\ncreate database before;\n` });

    /** Build one database from setup SQL; its tables and their seeded state. */
    const build = async (db: 'before' | 'after', sql: string) => {
      const built = await sandbox.psql({ db, user: 'postgres', sql: `${DATABASE_SHIM}\n${sql}\n;\n${INTROSPECT_SQL}`, tuplesOnly: true, timeoutS: 60 });
      const tables = parseTables(built.out);
      const targets = seedTargets(tables);
      const seeded = await sandbox.psql({ db, user: 'postgres', sql: `${USERS_SQL(users)}\n${seedSql(tables, users)}\n${seedCheckSql(targets, users)}`, tuplesOnly: true, timeoutS: 30 });
      return { tables, targets, state: parseSeedCheck(seeded.out), errors: seeded.out };
    };

    const after = await build('after', afterSql.sql);
    let ready = after.targets.filter((t) => after.state.some((s) => s.table === t.table && s.alice > 0 && s.canary));

    // Tables Lucid could not seed on its own, among those the commit touched: the model writes the rows.
    const missing = after.targets.filter((t) => input.touched.tables.includes(t.table) && !ready.includes(t));
    if (missing.length && Date.now() < deadline - 45_000) {
      ready = [...ready, ...(await modelSeed(sandbox, after.tables, missing, users, after.errors, attacker, usage.attacker))];
    }
    timings.setupMs = Date.now() - started;

    if (!ready.length) {
      return result({ status: 'not-reproduced', reason: 'no table with an owner column could be filled with fake users' });
    }
    const touched = ready.filter((t) => input.touched.tables.includes(t.table));
    const targets = [...touched, ...ready.filter((t) => !touched.includes(t))];

    // Every hit the ground truth confirms is weighed here, in order:
    //   1. a read of data clearly meant for everyone is no proof (the judge);
    //   2. the same query on the database as it was before the commit: a hit
    //      that worked before too is kept aside, and the attack looks on for
    //      something this commit opened.
    let found: { evidence: Evidence; verdict: Verdict | null; before: BeforeState } | null = null;
    let openBefore: { evidence: Evidence; verdict: Verdict | null } | null = null;
    let publicData: { evidence: Evidence; verdict: Verdict | null; reason: string | null } | null = null;
    const verdicts = new Map<string, Verdict | null>();
    const consider = async (evidence: Evidence): Promise<'keep' | 'skip'> => {
      let verdict: Verdict | null = null;
      if (evidence.action === 'read') {
        const judgeStarted = Date.now();
        if (!verdicts.has(evidence.table)) {
          const table = after.tables.find((t) => t.name === evidence.table)!;
          verdicts.set(evidence.table, await judgePrivacy(table, evidence, judgeProvider, usage.judge));
        }
        verdict = verdicts.get(evidence.table) ?? null;
        timings.judgeMs += Date.now() - judgeStarted;
        const kept = downgrade(evidence, verdict);
        if (!kept.keep) {
          publicData ??= { evidence, verdict, reason: kept.reason };
          return 'skip';
        }
      }
      const beforeStarted = Date.now();
      const before = await replayBefore(evidence).catch((): BeforeState => 'error');
      timings.beforeMs += Date.now() - beforeStarted;
      if (before === 'leaked') {
        openBefore ??= { evidence, verdict };
        return 'skip';
      }
      found = { evidence, verdict, before };
      return 'keep';
    };

    const attackStarted = Date.now();
    const outcome = await attack({ sandbox, db: 'after', users, tables: after.tables, targets, touched: input.touched.tables, deadline, attacker, usage: usage.attacker, consider });
    log = outcome.log;
    timings.attackMs = Date.now() - attackStarted - timings.judgeMs - timings.beforeMs;

    const proof = (f: { evidence: Evidence; verdict: Verdict | null }, before: BeforeState) =>
      result({
        status: 'proven',
        table: f.evidence.table,
        role: f.evidence.actor,
        action: f.evidence.action,
        rows: f.evidence.rows,
        query: f.evidence.query,
        judge: f.verdict,
        before,
        summary: summarize(log, f.evidence),
      });
    // A leak this commit opened; else one that was already open before (still a leak in these rules).
    const opened = found as { evidence: Evidence; verdict: Verdict | null; before: BeforeState } | null;
    if (opened) return proof(opened, opened.before);
    const already = openBefore as { evidence: Evidence; verdict: Verdict | null } | null;
    if (already) return proof(already, 'leaked');
    const shown = publicData as { evidence: Evidence; verdict: Verdict | null; reason: string | null } | null;
    if (shown) {
      const e = shown.evidence;
      return result({ status: 'not-reproduced', table: e.table, role: e.actor, action: e.action, rows: e.rows, query: e.query, judge: shown.verdict, reason: shown.reason, summary: summarize(log, null) });
    }
    return result({ status: 'not-reproduced', reason: Date.now() > deadline ? "ran out of time before reaching Alice's rows" : "no query reached Alice's rows" });
  } catch (err) {
    return result({ status: 'error', reason: `the sandbox could not finish: ${(err as Error).message}`.slice(0, 300) });
  } finally {
    await sandbox.stop().catch(() => undefined);
  }

  /** The BEFORE database, built once, the first time a hit needs it. */
  async function beforeDatabase(): Promise<{ tables: TableInfo[]; targets: SeedTarget[] } | 'error'> {
    if (beforeBuilt) return beforeBuilt;
    const sql = prepareSetupSql(joined(input.before));
    if (isRefusal(sql)) return (beforeBuilt = 'error');
    const built = await sandbox.psql({ db: 'before', user: 'postgres', sql: `${DATABASE_SHIM}\n${sql.sql}\n;\n${INTROSPECT_SQL}`, tuplesOnly: true, timeoutS: 60 });
    const tables = parseTables(built.out);
    await sandbox.psql({ db: 'before', user: 'postgres', sql: `${USERS_SQL(users)}\n${seedSql(tables, users)}`, timeoutS: 30 });
    return (beforeBuilt = { tables, targets: seedTargets(tables) });
  }

  /** The exact query that worked, as the same person, on the database as it was before the commit. */
  async function replayBefore(evidence: Evidence): Promise<BeforeState> {
    const db = await beforeDatabase();
    if (db === 'error') return 'error';
    const target = db.targets.find((t) => t.table === evidence.table);
    if (!target) return 'no-table';
    if (evidence.action === 'read') {
      const r = await runAs(sandbox, 'before', evidence.actor, evidence.query, users);
      return !r.tampered && canaryRowsIn(r.output, users.canary) > 0 ? 'leaked' : 'blocked';
    }
    const snap = async () => parseSnapshot((await sandbox.psql({ db: 'before', user: 'postgres', sql: snapshotSql([target], users), tuplesOnly: true })).out);
    const first = await snap();
    await runAs(sandbox, 'before', evidence.actor, evidence.query, users);
    return changesBetween(first, await snap()).length ? 'leaked' : 'blocked';
  }
};

/** The model writes seed rows for tables Lucid could not fill itself; run as the superuser, checked like any setup SQL. */
const modelSeed = async (sandbox: Sandbox, tables: TableInfo[], missing: SeedTarget[], u: FakeUsers, errors: string, provider: Provider, usage: Usage): Promise<SeedTarget[]> => {
  const described = missing.map((m) => {
    const t = tables.find((x) => x.name === m.table)!;
    return `TABLE public.${t.name} (owner column ${m.owner})\n${t.columns.map((c) => `  ${c.name} ${c.type}${c.notNull ? ' not null' : ''}${c.hasDefault ? ' (has default)' : ''}${c.enum ? ` one of ${c.enum.join('/')}` : ''}`).join('\n')}\n${t.fks.map((f) => `  link ${f.column} -> ${f.refTable}(${f.refColumn})`).join('\n')}`;
  });
  const text = await callModel(
    provider,
    {
      system: prompt('seedTables'),
      user: `ALICE = ${u.alice}\nBOB = ${u.bob}\nALICE_MARKER = ${u.canary}\n\n${described.join('\n\n')}\n\nERRORS FROM LUCID'S OWN SEEDING:\n${errors.split('\n').filter((l) => /ERROR|DETAIL/.test(l)).slice(0, 20).join('\n')}`,
      effort: 'low',
      maxTokens: 4000,
      usage,
    },
    () => JSON.stringify({ sql: 'select 1;' }),
  );
  const parsed = parseWith(SeedSchema, text);
  if (!parsed.ok || !/^\s*(insert\b[\s\S]*)$/i.test(parsed.value.sql)) return [];
  const safe = prepareSetupSql(parsed.value.sql);
  if (isRefusal(safe)) return [];
  const checked = await sandbox.psql({ db: 'after', user: 'postgres', sql: `${safe.sql}\n;\n${seedCheckSql(missing, u)}`, tuplesOnly: true, timeoutS: 20 });
  const state = parseSeedCheck(checked.out);
  return missing.filter((m) => state.some((s) => s.table === m.table && s.alice > 0 && s.canary));
};
