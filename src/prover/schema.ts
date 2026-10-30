/**
 * Reading the sandbox database, and filling it with two fake users.
 *
 * Alice and Bob are made up (alice@example.test, bob@example.test, fresh
 * ids). Every table with an owner-like column (user_id, owner_id, a link to
 * auth.users, …) gets one row for each. Alice's text values carry a canary,
 * a random marker like CANARY-ALICE-7Q2K9X, so the prover can tell her data
 * apart from anything else in an answer. Seeding runs as the superuser,
 * before any attack.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export interface Column {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  enum: string[] | null;
}

export interface ForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface Policy {
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface TableInfo {
  name: string;
  rls: boolean;
  columns: Column[];
  fks: ForeignKey[];
  policies: Policy[];
}

/** One query, one JSON value: every table in public with its columns, links and policies. */
export const INTROSPECT_SQL = `
select json_build_object('tables', coalesce((
  select json_agg(json_build_object(
    'name', c.relname,
    'rls', c.relrowsecurity,
    'columns', (select json_agg(json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull,
        'hasDefault', a.atthasdef or a.attidentity <> '' or a.attgenerated <> '',
        'enum', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid)
      ) order by a.attnum)
      from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
    'fks', (select json_agg(json_build_object(
        'column', (select attname from pg_attribute where attrelid = c.oid and attnum = con.conkey[1]),
        'refTable', (select rn.nspname || '.' || rc.relname from pg_class rc join pg_namespace rn on rn.oid = rc.relnamespace where rc.oid = con.confrelid),
        'refColumn', (select attname from pg_attribute where attrelid = con.confrelid and attnum = con.confkey[1])
      ))
      from pg_constraint con where con.conrelid = c.oid and con.contype = 'f'),
    'policies', (select json_agg(json_build_object('name', p.policyname, 'command', p.cmd, 'roles', p.roles, 'using', p.qual, 'withCheck', p.with_check))
      from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
  ) order by c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
), '[]'::json));
`;

/** The tables from the introspection output (psql, tuples only). */
export const parseTables = (out: string): TableInfo[] => {
  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`could not read the database: ${out.slice(0, 300)}`);
  const raw = JSON.parse(line) as { tables: (Omit<TableInfo, 'columns' | 'fks' | 'policies'> & Partial<Record<'columns' | 'fks' | 'policies', unknown[] | null>>)[] };
  return raw.tables.map((t) => ({
    name: t.name,
    rls: t.rls,
    columns: (t.columns ?? []) as Column[],
    fks: (t.fks ?? []) as ForeignKey[],
    policies: ((t.policies ?? []) as Policy[]).map((p) => ({ ...p, roles: p.roles ?? [] })),
  }));
};

// --- owners ----------------------------------------------------------------------

const OWNER_NAMES = ['user_id', 'owner_id', 'profile_id', 'author_id', 'created_by', 'creator_id', 'owner', 'uid', 'account_id', 'member_id'];

const isUuid = (c: Column) => c.type === 'uuid';

/**
 * The column that says whose row it is: a link to auth.users, a link to a
 * table whose own id is a user (profiles.id), or a well-known name.
 */
export const ownerColumn = (table: TableInfo, all: TableInfo[]): string | null => {
  const toUsers = table.fks.find((fk) => fk.refTable === 'auth.users');
  if (toUsers) return toUsers.column;
  const toProfiles = table.fks.find((fk) => {
    const target = all.find((t) => `public.${t.name}` === fk.refTable);
    return target?.fks.some((f) => f.refTable === 'auth.users' && f.column === fk.refColumn);
  });
  if (toProfiles) return toProfiles.column;
  const named = OWNER_NAMES.map((n) => table.columns.find((c) => c.name === n && isUuid(c))).find((c) => c);
  return named?.name ?? null;
};

// --- fake users ---------------------------------------------------------------------

export interface FakeUsers {
  alice: string;
  bob: string;
  /** Unique to this proof; every value seeded for Alice contains it. */
  canary: string;
}

export const makeFakeUsers = (): FakeUsers => ({
  alice: randomUUID(),
  bob: randomUUID(),
  canary: `CANARY-ALICE-${randomBytes(4).toString('hex').toUpperCase()}`,
});

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const TEXT = /^(text|character varying.*|varchar.*|citext|character.*|name)$/;
const INT = /^(integer|bigint|smallint)$/;
const NUMBER = /^(numeric.*|real|double precision|money)$/;
const TIME = /^(timestamp.*|date|time.*)$/;

export const USERS_SQL = (u: FakeUsers) => `
insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
  (${q(u.alice)}, 'alice@example.test', 'authenticated', 'authenticated', now(), ${q(JSON.stringify({ full_name: `${u.canary} Alice`, name: `${u.canary} Alice` }))}),
  (${q(u.bob)}, 'bob@example.test', 'authenticated', 'authenticated', now(), '{"full_name": "Bob Example", "name": "Bob Example"}');
`;

/** Tables that other tables link to come first. */
const ordered = (tables: TableInfo[]): TableInfo[] => {
  const out: TableInfo[] = [];
  const pending = [...tables];
  while (pending.length) {
    const i = pending.findIndex((t) => t.fks.every((fk) => !fk.refTable.startsWith('public.') || fk.refTable === `public.${t.name}` || out.some((o) => `public.${o.name}` === fk.refTable) || !pending.some((p) => `public.${p.name}` === fk.refTable)));
    out.push(...pending.splice(i < 0 ? 0 : i, 1));
  }
  return out;
};

/** A value for one column of one fake user's row, or null to leave it to its default. */
const valueFor = (table: TableInfo, c: Column, user: 'alice' | 'bob', u: FakeUsers, all: TableInfo[]): string | null => {
  const id = u[user];
  const fk = table.fks.find((f) => f.column === c.name);
  if (fk?.refTable === 'auth.users') return q(id);
  if (fk?.refTable.startsWith('public.')) {
    const target = all.find((t) => `public.${t.name}` === fk.refTable);
    const owner = target ? ownerColumn(target, all) : null;
    return `(select ${ident(fk.refColumn)} from ${fk.refTable.split('.').map(ident).join('.')}${owner ? ` where ${ident(owner)} = ${q(id)}` : ''} limit 1)`;
  }
  if (TEXT.test(c.type)) {
    // A text column with a default (a status like 'draft') keeps it: its own value may be checked.
    if (c.hasDefault) return null;
    return q(user === 'alice' ? `${u.canary}-${table.name}-${c.name}` : `bob-${c.name}`);
  }
  if (c.hasDefault || !c.notNull) {
    if (/^jsonb?$/.test(c.type) && user === 'alice') return q(JSON.stringify({ lucid: `${u.canary}-${table.name}` }));
    return null;
  }
  if (c.enum?.length) return q(c.enum[0]!);
  if (isUuid(c)) return 'gen_random_uuid()';
  if (INT.test(c.type)) return user === 'alice' ? '1' : '2';
  if (NUMBER.test(c.type)) return '1';
  if (c.type === 'boolean') return 'false';
  if (TIME.test(c.type)) return 'now()';
  if (/^jsonb?$/.test(c.type)) return user === 'alice' ? q(JSON.stringify({ lucid: `${u.canary}-${table.name}` })) : "'{}'";
  if (c.type.endsWith('[]')) return "'{}'";
  return null;
};

export interface SeedTarget {
  table: string;
  owner: string;
}

/** The tables the prover can attack: those with an owner column. */
export const seedTargets = (tables: TableInfo[]): SeedTarget[] =>
  tables.map((t) => ({ table: t.name, owner: ownerColumn(t, tables) })).filter((x): x is SeedTarget => x.owner !== null);

/**
 * One row for Alice and one for Bob in every table with an owner, then make
 * sure one of Alice's text values carries the canary (a sign-up trigger may
 * already have made her row, without it).
 */
export const seedSql = (tables: TableInfo[], u: FakeUsers): string => {
  const lines: string[] = [];
  for (const table of ordered(tables)) {
    const owner = ownerColumn(table, tables);
    if (!owner) continue;
    const name = `public.${ident(table.name)}`;
    for (const user of ['alice', 'bob'] as const) {
      const cols = table.columns
        .map((c) => ({ c, v: c.name === owner ? q(u[user]) : valueFor(table, c, user, u, tables) }))
        .filter((x): x is { c: Column; v: string } => x.v !== null);
      lines.push(`insert into ${name} (${cols.map((x) => ident(x.c.name)).join(', ')}) values (${cols.map((x) => x.v).join(', ')}) on conflict do nothing;`);
    }
    const text = table.columns.find((c) => TEXT.test(c.type) && c.name !== owner && !c.hasDefault);
    if (text) lines.push(`update ${name} x set ${ident(text.name)} = ${q(`${u.canary}-${table.name}-${text.name}`)} where x.${ident(owner)} = ${q(u.alice)} and x::text not like ${q(`%${u.canary}%`)};`);
  }
  return lines.join('\n');
};

/** Per table: Alice's rows, Bob's rows, and whether Alice's carry the canary. Tab-separated, one line each. */
export const seedCheckSql = (targets: SeedTarget[], u: FakeUsers): string =>
  targets
    .map(
      (t) =>
        `select ${q(t.table)}, count(*) filter (where ${ident(t.owner)} = ${q(u.alice)}), count(*) filter (where ${ident(t.owner)} = ${q(u.bob)}), coalesce(bool_or(x::text like ${q(`%${u.canary}%`)}) filter (where ${ident(t.owner)} = ${q(u.alice)}), false) from public.${ident(t.table)} x;`,
    )
    .join('\n');

export interface SeedState {
  table: string;
  alice: number;
  bob: number;
  canary: boolean;
}

export const parseSeedCheck = (out: string): SeedState[] =>
  out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length === 4 && /^\d+$/.test(p[1]!))
    .map(([table, alice, bob, canary]) => ({ table: table!, alice: Number(alice), bob: Number(bob), canary: canary === 't' }));

/** Alice's rows per table as a fingerprint, so a change or a delete by someone else shows. */
export const snapshotSql = (targets: SeedTarget[], u: FakeUsers): string =>
  targets
    .map((t) => `select ${q(t.table)}, count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.${ident(t.table)} x where ${ident(t.owner)} = ${q(u.alice)};`)
    .join('\n');

export type Snapshot = Record<string, { rows: number; hash: string }>;

export const parseSnapshot = (out: string): Snapshot =>
  Object.fromEntries(
    out
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p) => p.length === 3 && /^\d+$/.test(p[1]!))
      .map(([table, rows, hash]) => [table!, { rows: Number(rows), hash: hash! }]),
  );
