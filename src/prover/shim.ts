/**
 * Just enough of Supabase for the builder's database rules to run as they
 * would in their project: the roles the API uses (anon, authenticated,
 * service_role), auth.users, and auth.uid() / auth.role() / auth.jwt(),
 * which read the request's JWT claims from `request.jwt.claims` exactly like
 * Supabase does. Like Supabase, every table in public is granted to anon and
 * authenticated: row level security is the only thing in the way.
 */

/** Once per sandbox, as the superuser in the postgres database. */
export const CLUSTER_SHIM = `
create role anon login noinherit;
create role authenticated login noinherit;
create role service_role nologin noinherit bypassrls;
alter role postgres set search_path = "$user", public, extensions;
alter role anon set search_path = "$user", public, extensions;
alter role authenticated set search_path = "$user", public, extensions;
`;

/** In each database (before and after), as the superuser, before the builder's setup. */
export const DATABASE_SHIM = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant usage on schema public, extensions to anon, authenticated, service_role;

create schema if not exists auth;
create table auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  phone text,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean,
  is_anonymous boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_sign_in_at timestamptz,
  deleted_at timestamptz
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), auth.jwt() ->> 'sub'), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true), auth.jwt() ->> 'role'), '')
$$;
create function auth.email() returns text language sql stable as $$
  select auth.jwt() ->> 'email'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
`;
