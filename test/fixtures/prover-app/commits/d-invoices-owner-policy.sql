create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  customer_name text not null,
  amount_cents integer not null,
  created_at timestamptz not null default now()
);
alter table public.invoices enable row level security;

create policy "owners read their invoices"
  on public.invoices for select
  using (auth.uid() = owner_id);
create policy "owners add invoices"
  on public.invoices for insert
  with check (auth.uid() = owner_id);
