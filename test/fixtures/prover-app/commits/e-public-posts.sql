-- A public blog: anyone may read posts; only authors write theirs.
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text not null,
  published_at timestamptz not null default now()
);
alter table public.posts enable row level security;

create policy "posts are public"
  on public.posts for select
  using (true);
create policy "authors write their posts"
  on public.posts for insert
  with check (auth.uid() = author_id);
create policy "authors edit their posts"
  on public.posts for update
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
