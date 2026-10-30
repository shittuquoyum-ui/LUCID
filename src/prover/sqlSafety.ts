/**
 * What SQL may run in the prover's sandbox.
 *
 * The sandbox already has no network and is destroyed after every proof.
 * These checks are a second wall:
 *   - setup files (the builder's migrations) run as the database superuser,
 *     so psql meta-commands are stripped, extensions outside a short list are
 *     not installed, and anything that reads or writes files or runs programs
 *     stops the proof;
 *   - the attacker's SQL runs as a signed-out visitor or as Bob, and may not
 *     touch files, programs, other servers, the session's identity (role,
 *     JWT claims) or the schema.
 */

/** Extensions that ship with Postgres and touch no files or network. */
export const ALLOWED_EXTENSIONS = new Set([
  'pgcrypto', 'uuid-ossp', 'citext', 'pg_trgm', 'unaccent', 'ltree', 'hstore', 'btree_gist', 'btree_gin', 'fuzzystrmatch', 'moddatetime', 'pg_stat_statements',
]);

/** Never allowed anywhere: files, programs, other servers. */
const FILE_OR_NETWORK: [RegExp, string][] = [
  [/\bcopy\b[^;]*\bprogram\b/i, 'COPY … PROGRAM'],
  [/\bcopy\b[^;]*\b(?:from|to)\s+(?:e?'|\$)/i, 'COPY to or from a file'],
  [/\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_file_write|lo_import|lo_export)\s*\(/i, 'reading or writing files'],
  [/\bdblink\w*\s*\(/i, 'dblink'],
  [/\b(?:create\s+server|create\s+foreign\s+(?:data\s+wrapper|table)|import\s+foreign\s+schema)\b/i, 'foreign servers'],
  [/\bnet\.http_\w+\s*\(|\bhttp_(?:get|post|put|patch|delete|head|request)\s*\(/i, 'web requests (pg_net / http)'],
  [/\b(?:language\s+(?:plpython|plperlu|pltcl)\w*)\b/i, 'untrusted function languages'],
];

/** Also refused in the attacker's SQL: changing who it is, or the schema. */
const IDENTITY_OR_SCHEMA: [RegExp, string][] = [
  [/\bset_config\s*\(/i, 'changing settings (set_config)'],
  [/(?:^|;)\s*(?:set|reset)\b/i, 'SET / RESET'],
  [/\bsession\s+authorization\b/i, 'changing the session user'],
  [/(?:^|;)\s*(?:do|execute|prepare|call|create|alter|drop|grant|revoke|truncate|copy|listen|notify|vacuum|analyze|cluster|reindex|comment|load|lock)\b/i, 'commands other than SELECT, INSERT, UPDATE and DELETE'],
];

export interface Refusal {
  refused: true;
  reason: string;
}

const firstHit = (sql: string, rules: [RegExp, string][]): string | null => rules.find(([re]) => re.test(sql))?.[1] ?? null;

/** Lines starting with a backslash are psql commands (\copy, \!, \i …), never SQL. */
export const stripMetaCommands = (sql: string): string => sql.replace(/^[ \t]*\\.*$/gm, '-- (psql command removed by Lucid)');

const EXTENSION = /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([\w-]+))[^;]*;/gi;

export interface PreparedSetup {
  sql: string;
  /** Extensions the setup asked for that the sandbox does not install. */
  skippedExtensions: string[];
}

/** A setup file made ready for the sandbox, or why it cannot run there. */
export const prepareSetupSql = (sql: string): PreparedSetup | Refusal => {
  const clean = stripMetaCommands(sql);
  const hit = firstHit(clean, FILE_OR_NETWORK);
  if (hit) return { refused: true, reason: `the database setup uses ${hit}, which Lucid's sandbox refuses` };
  const skippedExtensions: string[] = [];
  const out = clean.replace(EXTENSION, (stmt, quoted: string | undefined, bare: string | undefined) => {
    const name = (quoted ?? bare ?? '').toLowerCase();
    if (ALLOWED_EXTENSIONS.has(name)) return stmt.replace(/\bwith\s+schema\s+[^\s;]+/i, 'with schema extensions');
    skippedExtensions.push(name);
    return `-- (extension ${name} not installed in Lucid's sandbox)`;
  });
  return { sql: out, skippedExtensions };
};

/** The attacker's SQL, or why it may not run. */
export const checkAttackSql = (sql: string): string | null => {
  if (/^[ \t]*\\/m.test(sql)) return 'refused: psql commands';
  const hit = firstHit(sql, FILE_OR_NETWORK) ?? firstHit(sql, IDENTITY_OR_SCHEMA);
  return hit ? `refused: ${hit}` : null;
};

export const isRefusal = (x: PreparedSetup | Refusal): x is Refusal => 'refused' in x;
