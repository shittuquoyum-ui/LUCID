/**
 * The attack on the sandbox database: can a signed-out visitor (anon) or
 * another signed-in user (Bob) read, change or delete Alice's rows?
 *
 * Two layers, both through the same logged tool, run_as:
 *   1. standard probes, written by code: read every target table as anon
 *      and as Bob, then try to change and delete Alice's rows;
 *   2. if none of those got through, the attacker model (Muse Spark 1.3)
 *      looks at the tables, policies, views and functions and tries its own
 *      queries, within 12 tool calls and about 60 seconds.
 *
 * Ground truth decides, never the model's word: a read counts only when
 * Alice's canary came back in an answer; a write counts only when Alice's
 * rows (fingerprinted by the superuser) changed, vanished or gained a row
 * after a query by someone who is not Alice.
 */
import { parseWith } from '../engine/json';
import { callModel, type Provider, type Usage } from '../engine/model';
import { prompt } from '../engine/prompts';
import { z } from 'zod';
import type { Sandbox } from './sandbox';
import { ident, parseSnapshot, snapshotSql, type FakeUsers, type FunctionInfo, type SeedTarget, type Snapshot, type TableInfo, type ViewInfo } from './schema';
import { checkAttackSql } from './sqlSafety';

export type Actor = 'anon' | 'bob';
export type Action = 'read' | 'update' | 'delete' | 'insert';

export interface ToolCall {
  n: number;
  tool: 'list_tables' | 'describe_table' | 'list_policies' | 'list_views' | 'list_functions' | 'run_as';
  /** Who wrote the call: the standard probes or the attacker model. */
  by: 'probe' | 'attacker';
  actor?: Actor;
  table?: string;
  sql?: string;
  output: string;
  ms: number;
  refused?: string;
  /** Lines of the answer that carry Alice's canary. */
  canaryRows: number;
}

export interface Evidence {
  actor: Actor;
  action: Action;
  table: string;
  rows: number;
  query: string;
  /** Who wrote the query that worked. */
  by: 'probe' | 'attacker';
  /** A read that came back although this person's plain read of the table did not: the table's own rule hides the row from them. */
  hiddenByTableRule?: boolean;
}

export interface AttackContext {
  sandbox: Sandbox;
  db: string;
  users: FakeUsers;
  tables: TableInfo[];
  views?: ViewInfo[];
  functions?: FunctionInfo[];
  /** Tables with an owner column, the commit's first. */
  targets: SeedTarget[];
  /** Stop starting new work after this time (ms since epoch). */
  deadline: number;
  attacker: Provider;
  usage?: Usage;
  /** Most tool calls the attacker model may make. */
  maxAgentCalls?: number;
  /** The tables the commit touched; probed first, with every probe, before any other table. */
  touched?: string[];
  /** The views and functions the commit touched; the attacker model is told. */
  touchedRoutes?: string[];
  /**
   * Called for every hit the ground truth confirms. 'keep' ends the attack
   * with it; 'skip' (for example: already open before the commit, or data
   * meant for everyone) keeps searching. Without it, the first hit is kept.
   */
  consider?: (evidence: Evidence) => Promise<'keep' | 'skip'>;
}

const STATEMENT_TIMEOUT_MS = 3000;
const OUTPUT_KEEP = 2000;

/** How the session presents itself: Supabase's JWT claims, as PostgREST sets them. */
export const connectionFor = (actor: Actor, u: FakeUsers): { user: 'anon' | 'authenticated'; options: string } => {
  const claims =
    actor === 'anon'
      ? { role: 'anon' }
      : { sub: u.bob, role: 'authenticated', aud: 'authenticated', email: 'bob@example.test' };
  const parts = [`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`, `-c request.jwt.claims=${JSON.stringify(claims)}`, `-c request.jwt.claim.role=${claims.role}`];
  if (actor === 'bob') parts.push(`-c request.jwt.claim.sub=${u.bob}`);
  return { user: actor === 'anon' ? 'anon' : 'authenticated', options: parts.join(' ') };
};

const NOISE = /^(psql:|LINE \d+:|ERROR:|DETAIL:|HINT:|CONTEXT:|NOTICE:|WARNING:|\s*\^)/;

/** Lines of real answer rows that carry the canary (error messages that echo a query never count). */
export const canaryRowsIn = (output: string, canary: string): number =>
  output.split('\n').filter((l) => l.includes(canary) && !NOISE.test(l)).length;

/** Which table the leaked canary came from: seeded values read CANARY-…-<table>-<column>. */
export const tableOfCanary = (output: string, canary: string, targets: SeedTarget[]): string | null => {
  const line = output.split('\n').find((l) => l.includes(canary) && !NOISE.test(l));
  if (!line) return null;
  const hit = targets.find((t) => line.includes(`${canary}-${t.table}-`));
  return hit?.table ?? null;
};

const END = 'LUCID-END';

/**
 * Run SQL as anon or Bob, never as the superuser. The session ends with a
 * check of who it was; an answer from a session that changed who it was
 * (it should not be able to) is thrown away.
 */
export const runAs = async (sandbox: Sandbox, db: string, actor: Actor, sql: string, u: FakeUsers): Promise<{ output: string; ms: number; tampered: boolean }> => {
  const { user, options } = connectionFor(actor, u);
  const r = await sandbox.psql({ db, user, options, sql: `${sql}\n;\nselect '${END}', current_user, coalesce(auth.uid()::text, '-');\n`, timeoutS: 15 });
  const lines = r.out.split('\n');
  const endAt = lines.map((l) => l.startsWith(`${END}\t`)).lastIndexOf(true);
  const end = endAt >= 0 ? lines[endAt]!.split('\t') : null;
  const expected = actor === 'anon' ? ['anon', '-'] : ['authenticated', u.bob];
  const tampered = !end || end[1] !== expected[0] || end[2] !== expected[1];
  const output = lines.slice(0, endAt >= 0 ? Math.max(0, endAt - 1) : lines.length).join('\n').trim();
  return { output, ms: r.ms, tampered };
};

/** Several statements as one actor in one session, each answer split out. */
const runBatch = async (ctx: AttackContext, actor: Actor, queries: { table: string; sql: string }[]) => {
  const marked = queries.map((qy, i) => `\\echo LUCID-Q${i}\n${qy.sql}`).join('\n');
  const r = await runAs(ctx.sandbox, ctx.db, actor, marked, ctx.users);
  const parts = r.output.split(/^LUCID-Q(\d+)$/m);
  const answers = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) answers.set(Number(parts[i]), parts[i + 1]!.trim());
  return { ...r, answers: queries.map((qy, i) => ({ ...qy, output: r.tampered ? '' : answers.get(i) ?? '' })) };
};

const takeSnapshot = async (ctx: AttackContext): Promise<Snapshot> => {
  const r = await ctx.sandbox.psql({ db: ctx.db, user: 'postgres', sql: snapshotSql(ctx.targets, ctx.users), tuplesOnly: true, timeoutS: 15 });
  return parseSnapshot(r.out);
};

/** Which of Alice's tables changed between two fingerprints, and how. */
export const changesBetween = (before: Snapshot, after: Snapshot): { table: string; action: 'update' | 'delete' | 'insert'; rows: number }[] =>
  Object.entries(before)
    .filter(([t, b]) => after[t] && (after[t]!.rows !== b.rows || after[t]!.hash !== b.hash))
    .map(([t, b]) => {
      const a = after[t]!;
      if (a.rows > b.rows) return { table: t, action: 'insert' as const, rows: a.rows - b.rows };
      return a.rows < b.rows ? { table: t, action: 'delete' as const, rows: b.rows - a.rows } : { table: t, action: 'update' as const, rows: Math.max(1, b.rows) };
    });

const TEXT = /^(text|character varying.*|varchar.*|citext)$/;

export interface AttackOutcome {
  evidence: Evidence | null;
  log: ToolCall[];
  ms: number;
}

export const attack = async (ctx: AttackContext): Promise<AttackOutcome> => {
  const started = Date.now();
  const log: ToolCall[] = [];
  const record = (call: Omit<ToolCall, 'n'>): ToolCall => {
    const entry = { ...call, n: log.length + 1, output: call.output.slice(0, OUTPUT_KEEP) };
    log.push(entry);
    return entry;
  };
  const done = (evidence: Evidence | null): AttackOutcome => ({ evidence, log, ms: Date.now() - started });
  const { users: u } = ctx;
  const consider = ctx.consider ?? (async () => 'keep' as const);

  // 1. Standard probes, the commit's tables first: reads, then changes, then
  //    deletes, each by a signed-out visitor and by Bob. Every hit is offered
  //    to `consider`; one it skips (already open before the commit, or public
  //    data) does not stop the search.
  const touched = ctx.targets.filter((t) => ctx.touched?.includes(t.table));
  const groups = [touched, ctx.targets.filter((t) => !touched.includes(t))].filter((g) => g.length);
  let snapshot = await takeSnapshot(ctx);

  for (const group of groups) {
    for (const actor of ['anon', 'bob'] as const) {
      if (Date.now() > ctx.deadline) return done(null);
      const batch = await runBatch(ctx, actor, group.map((t) => ({ table: t.table, sql: `select * from public.${ident(t.table)};` })));
      const calls = batch.answers.map((a) =>
        record({ tool: 'run_as', by: 'probe', actor, table: a.table, sql: a.sql, output: a.output, ms: Math.round(batch.ms / batch.answers.length), canaryRows: canaryRowsIn(a.output, u.canary) }),
      );
      for (const hit of calls.filter((c) => c.canaryRows > 0)) {
        const evidence: Evidence = { actor, action: 'read', table: hit.table!, rows: hit.canaryRows, query: hit.sql!, by: 'probe' };
        if ((await consider(evidence)) === 'keep') return done(evidence);
      }
    }

    const writes = (kind: Action) =>
      group.flatMap((t) => {
        const table = ctx.tables.find((x) => x.name === t.table);
        const text = table?.columns.find((c) => TEXT.test(c.type) && c.name !== t.owner);
        const where = `where ${ident(t.owner)} = '${u.alice}'`;
        if (kind === 'delete') return [{ table: t.table, sql: `delete from public.${ident(t.table)} ${where};` }];
        return text ? [{ table: t.table, sql: `update public.${ident(t.table)} set ${ident(text.name)} = ${ident(text.name)} || ' (changed)' ${where};` }] : [];
      });
    for (const kind of ['update', 'delete'] as const) {
      for (const actor of ['anon', 'bob'] as const) {
        if (Date.now() > ctx.deadline) return done(null);
        const queries = writes(kind);
        if (!queries.length) continue;
        const batch = await runBatch(ctx, actor, queries);
        for (const a of batch.answers) record({ tool: 'run_as', by: 'probe', actor, table: a.table, sql: a.sql, output: a.output, ms: Math.round(batch.ms / batch.answers.length), canaryRows: 0 });
        // Alice's rows, fingerprinted by the superuser, before and after: a change is a fact, not a claim.
        const next = await takeSnapshot(ctx);
        const changed = batch.tampered ? [] : changesBetween(snapshot, next);
        snapshot = next;
        for (const hit of changed) {
          // A trigger or a cascade can change another of Alice's tables than the one queried.
          const query = (queries.find((qy) => qy.table === hit.table) ?? queries[0]!).sql;
          const evidence: Evidence = { actor, action: hit.action, table: hit.table, rows: hit.rows, query, by: 'probe' };
          if ((await consider(evidence)) === 'keep') return done(evidence);
        }
      }
    }
  }

  // 2. The attacker model.
  const plainReadOpen = (actor: Actor, table: string) => log.some((c) => c.by === 'probe' && c.actor === actor && c.table === table && c.canaryRows > 0);
  const evidence = await runAgent(ctx, record, consider, () => snapshot, (s) => (snapshot = s), plainReadOpen);
  return done(evidence);
};

// --- the attacker model -----------------------------------------------------------

const ActionSchema = z.object({
  tool: z.enum(['list_tables', 'describe_table', 'list_policies', 'list_views', 'list_functions', 'run_as', 'done']),
  args: z.object({ table: z.string().optional(), role: z.enum(['anon', 'bob']).optional(), sql: z.string().max(4000).optional() }).default({}),
  why: z.string().max(400).optional(),
});

const tableSummary = (ctx: AttackContext) =>
  ctx.tables
    .map((t) => {
      const target = ctx.targets.find((x) => x.table === t.name);
      return `- ${t.name}${t.rls ? '' : ' (row level security OFF)'}${target ? `, owner column ${target.owner}` : ''}`;
    })
    .join('\n');

const INFO_KEEP = 6000;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const who = (x: { anon: boolean; authenticated: boolean }) => [x.anon ? 'anon' : null, x.authenticated ? 'bob' : null].filter(Boolean).join(' and ') || 'nobody here';

const viewList = (ctx: AttackContext): string =>
  ctx.views?.length
    ? ctx.views.map((v) => `- ${v.name}: security_invoker ${v.securityInvoker ? 'on' : 'off'}; ${who(v)} may read it\n  ${oneLine(v.definition)}`).join('\n')
    : 'no views in public';

const functionList = (ctx: AttackContext): string =>
  ctx.functions?.length
    ? ctx.functions.map((f) => `- ${f.name}(${f.args}) returns ${f.returns}: ${f.securityDefiner ? 'security definer' : 'security invoker'}; ${who(f)} may call it\n  ${oneLine(f.source)}`).join('\n')
    : 'no functions anyone can call in public';

const answerInfo = (ctx: AttackContext, tool: string, table?: string): string => {
  if (tool === 'list_tables') return tableSummary(ctx);
  if (tool === 'list_views') return viewList(ctx).slice(0, INFO_KEEP);
  if (tool === 'list_functions') return functionList(ctx).slice(0, INFO_KEEP);
  const t = ctx.tables.find((x) => x.name === table?.replace(/^public\./, '').replace(/"/g, ''));
  if (!t) return `no table named ${table ?? '(none)'} in public`;
  if (tool === 'describe_table') {
    return [...t.columns.map((c) => `${c.name} ${c.type}${c.notNull ? ' not null' : ''}`), ...t.fks.map((f) => `link: ${f.column} -> ${f.refTable}(${f.refColumn})`)].join('\n');
  }
  return t.policies.length
    ? t.policies.map((p) => `${p.name}: ${p.command} to ${p.roles.join(', ')}${p.using ? ` using (${p.using})` : ''}${p.withCheck ? ` with check (${p.withCheck})` : ''}`).join('\n')
    : `no policies${t.rls ? ' (row level security is on, so nothing is allowed)' : ' (row level security is off)'}`;
};

const runAgent = async (
  ctx: AttackContext,
  record: (call: Omit<ToolCall, 'n'>) => ToolCall,
  consider: (evidence: Evidence) => Promise<'keep' | 'skip'>,
  getSnapshot: () => Snapshot,
  setSnapshot: (s: Snapshot) => void,
  plainReadOpen: (actor: Actor, table: string) => boolean,
): Promise<Evidence | null> => {
  const max = ctx.maxAgentCalls ?? 12;
  const agentEnd = Math.min(ctx.deadline, Date.now() + 60_000);
  const system = prompt('attackDatabase');
  const brief = [
    `FAKE USERS: alice = ${ctx.users.alice}, bob = ${ctx.users.bob} (bob@example.test).`,
    `TARGET TABLES (the commit touched these): ${ctx.touched?.length ? ctx.touched.join(', ') : ctx.targets.map((t) => t.table).join(', ')}`,
    ...(ctx.touchedRoutes?.length ? [`VIEWS AND FUNCTIONS THE COMMIT TOUCHED: ${ctx.touchedRoutes.join(', ')}`] : []),
    `TABLES:\n${tableSummary(ctx)}`,
    `There are ${ctx.views?.length ?? 0} views and ${ctx.functions?.length ?? 0} functions in public.`,
    "The standard probes already tried a plain read, change and delete of Alice's rows as anon and as bob, in every table with an owner column. Look for what they could miss.",
  ].join('\n\n');
  /** A hit the prover does not keep: say so, and keep looking. */
  const offer = async (evidence: Evidence): Promise<Evidence | null> => {
    if ((await consider(evidence)) === 'keep') return evidence;
    transcript.push('(that one does not count: it was already possible before this commit, or the data is meant for everyone. Look for something else.)');
    return null;
  };
  const transcript: string[] = [];

  for (let calls = 0; calls < max && Date.now() < agentEnd; calls += 1) {
    let text: string;
    try {
      text = await callModel(
        ctx.attacker,
        { system, user: `${brief}\n\nSO FAR:\n${transcript.join('\n\n') || '(nothing yet)'}\n\nYour next action, as JSON:`, effort: 'low', maxTokens: 6000, usage: ctx.usage },
        () => JSON.stringify({ tool: 'done', args: {}, why: 'fake attacker' }),
      );
    } catch {
      // One bad answer costs one call, not the proof. The probes' work is not lost either.
      transcript.push('(your last answer never arrived. Answer with one short JSON action.)');
      continue;
    }
    const parsed = parseWith(ActionSchema, text);
    if (!parsed.ok) {
      transcript.push(`(your last answer was not valid JSON: ${parsed.problems.join('; ')})`);
      continue;
    }
    const { tool, args } = parsed.value;
    if (tool === 'done') break;
    if (tool !== 'run_as') {
      const output = answerInfo(ctx, tool, args.table);
      record({ tool, by: 'attacker', table: args.table, output, ms: 0, canaryRows: 0 });
      transcript.push(`${tool}(${args.table ?? ''}):\n${output}`);
      continue;
    }

    const actor = args.role ?? 'anon';
    const sql = args.sql?.trim() ?? '';
    const refused = sql ? checkAttackSql(sql) : 'refused: no SQL';
    if (refused) {
      record({ tool, by: 'attacker', actor, sql, output: '', ms: 0, refused, canaryRows: 0 });
      transcript.push(`run_as(${actor}): ${sql}\n${refused}`);
      continue;
    }
    const r = await runAs(ctx.sandbox, ctx.db, actor, sql, ctx.users);
    const output = r.tampered ? '' : r.output;
    const call = record({ tool, by: 'attacker', actor, sql, output, ms: r.ms, canaryRows: canaryRowsIn(output, ctx.users.canary), ...(r.tampered ? { refused: 'the session changed who it was' } : {}) });
    // The model never sees the canary: it is replaced before the answer goes back.
    transcript.push(`run_as(${actor}): ${sql}\n${output.split(ctx.users.canary).join('<alice-data>').slice(0, 1500) || '(no rows)'}`);
    if (call.canaryRows > 0) {
      const table = tableOfCanary(output, ctx.users.canary, ctx.targets) ?? ctx.targets[0]!.table;
      const kept = await offer({ actor, action: 'read', table, rows: call.canaryRows, query: sql, by: 'attacker', hiddenByTableRule: !plainReadOpen(actor, table) });
      if (kept) return kept;
    }
    // After every query, not only ones that read like writes: a function can write too.
    if (!r.tampered) {
      const next = await takeSnapshot(ctx);
      const changed = changesBetween(getSnapshot(), next);
      setSnapshot(next);
      for (const hit of changed) {
        const kept = await offer({ actor, action: hit.action, table: hit.table, rows: hit.rows, query: sql, by: 'attacker' });
        if (kept) return kept;
      }
    }
  }
  return null;
};
