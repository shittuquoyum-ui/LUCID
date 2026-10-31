/**
 * The only files the prover ever gets: the database setup (.sql files in
 * migrations folders, supabase/schemas, or a schema.sql), as they were
 * before the commit and after it. Never data (seed files), never other code.
 * Secret values are masked like everywhere else, and each version is capped
 * at 1 MB. Plain code: the extension uses it to choose what to send, the
 * server uses it again to check what it got.
 */
import { isChange, type DiffFile } from '../engine/diff';
import { maskSecrets } from '../engine/filter';

export interface SetupFile {
  path: string;
  text: string;
}

export const SETUP_MAX_BYTES = 1_000_000;

const MIGRATIONS = /(^|\/)migrations\/.+\.sql$/i;
const SCHEMAS = /(^|\/)supabase\/schemas\/.+\.sql$/i;
const SCHEMA_FILE = /(^|\/)schema\.sql$/i;
/** Seed files hold data, never sent. */
const SEED = /(^|\/)[^/]*seed[^/]*$|(^|\/)seeds?\//i;

export const isSetupPath = (path: string): boolean =>
  !SEED.test(path) && (MIGRATIONS.test(path) || SCHEMAS.test(path) || SCHEMA_FILE.test(path));

/**
 * The files in the order they would build the database: migrations by name
 * (their names start with a timestamp), else declarative schema files, else
 * one schema.sql. Mixing them would create every table twice.
 */
export const orderSetupFiles = (files: SetupFile[]): SetupFile[] => {
  const byPath = (a: SetupFile, b: SetupFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const pick = (re: RegExp) => files.filter((f) => re.test(f.path) && !SEED.test(f.path)).sort(byPath);
  const migrations = pick(MIGRATIONS);
  if (migrations.length) return migrations;
  const schemas = pick(SCHEMAS);
  if (schemas.length) return schemas;
  return pick(SCHEMA_FILE).slice(0, 1);
};

export const setupBytes = (files: SetupFile[]): number => files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0);

/** Ready to send: setup files only, secrets masked, in order. Null when they are over the cap. */
export const prepareSetupFiles = (files: SetupFile[]): SetupFile[] | null => {
  const chosen = orderSetupFiles(files.filter((f) => isSetupPath(f.path))).map((f) => ({
    path: f.path,
    text: f.text.split('\n').map(maskSecrets).join('\n'),
  }));
  return setupBytes(chosen) > SETUP_MAX_BYTES ? null : chosen;
};

// --- what the commit touched -----------------------------------------------------

export interface Touched {
  tables: string[];
  policies: string[];
  views: string[];
  functions: string[];
}

/** "public"."Notes" -> notes; auth.users stays auth.users. */
export const tableName = (raw: string): string => {
  const parts = raw.split('.').map((p) => p.replace(/"/g, '').trim().toLowerCase());
  return parts.length === 2 && parts[0] === 'public' ? parts[1]! : parts.join('.');
};

const NAME = String.raw`((?:"[^"]+"|[\w]+)(?:\s*\.\s*(?:"[^"]+"|[\w]+))?)`;
const TABLE_STATEMENT = new RegExp(String.raw`\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?${NAME}`, 'gi');
const POLICY_STATEMENT = new RegExp(String.raw`\b(?:create|alter|drop)\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\w+)\s+on\s+${NAME}`, 'gi');
const GRANT_ON = new RegExp(String.raw`\b(?:grant|revoke)\b[^;]*?\bon\s+(?:table\s+)?${NAME}`, 'gi');
const VIEW_STATEMENT = new RegExp(String.raw`\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+(?:not\s+)?exists\s+)?${NAME}`, 'gi');
const FUNCTION_STATEMENT = new RegExp(String.raw`\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?function\s+(?:if\s+exists\s+)?${NAME}`, 'gi');

/** Tables, policies, views and functions named in the setup lines a commit added or removed. */
export const touchedObjects = (files: DiffFile[]): Touched => {
  const text = files
    .filter((f) => isSetupPath(f.path))
    .flatMap((f) => f.lines.filter(isChange).map((l) => l.text))
    .join('\n');
  const tables = new Set<string>();
  const policies = new Set<string>();
  for (const m of text.matchAll(TABLE_STATEMENT)) tables.add(tableName(m[1]!));
  for (const m of text.matchAll(GRANT_ON)) tables.add(tableName(m[1]!));
  for (const m of text.matchAll(POLICY_STATEMENT)) {
    policies.add(m[1]!.replace(/"/g, ''));
    tables.add(tableName(m[2]!));
  }
  const namesOf = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => tableName(m[1]!)))];
  return {
    tables: [...tables].filter((t) => !t.startsWith('auth.') && !t.startsWith('storage.')),
    policies: [...policies],
    views: namesOf(VIEW_STATEMENT),
    functions: namesOf(FUNCTION_STATEMENT),
  };
};
