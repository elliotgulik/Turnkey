-- TurnKey app schema: customers + auth-linked users + RLS.
-- Run this once in the Supabase SQL editor (or `supabase db push` if you link the project).
-- Safe to re-run: every statement is idempotent.

-- ===== customers =====
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  name text not null,
  email text,
  phone text,
  address text,
  suburb text,
  notes text,
  source text,
  created_at timestamptz not null default now()
);

-- ===== jobs: link to customers + a flexible column for the rest of the pipeline record =====
alter table public.jobs add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.jobs add column if not exists details jsonb;

-- ===== public.users: profile row per auth user, carries business_id =====
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id text not null,
  email text,
  created_at timestamptz not null default now()
);

-- Auto-provision a profile (and a business_id equal to the user's own id) on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, business_id, email)
  values (new.id, new.id::text, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== RLS: every row scoped to the caller's business_id =====
-- Includes `quotes` and `Leads`, which already existed with no RLS — once the anon
-- key is public in the browser, any unprotected table is world-readable, so these
-- are locked down here too even though the app doesn't query them yet.
alter table public.customers enable row level security;
alter table public.jobs enable row level security;
alter table public.invoices enable row level security;
alter table public.users enable row level security;
alter table public.quotes enable row level security;
alter table public."Leads" enable row level security;

drop policy if exists "own business" on public.customers;
create policy "own business" on public.customers
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

drop policy if exists "own business" on public.jobs;
create policy "own business" on public.jobs
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

drop policy if exists "own business" on public.invoices;
create policy "own business" on public.invoices
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

drop policy if exists "own business" on public.quotes;
create policy "own business" on public.quotes
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

drop policy if exists "own business" on public."Leads";
create policy "own business" on public."Leads"
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

drop policy if exists "self select" on public.users;
create policy "self select" on public.users
  for select using (id = auth.uid());

-- Deliberately no update policy: every other table's RLS trusts
-- public.users.business_id as the source of truth, so letting a user change
-- their own business_id (even just on their own row) would let them take
-- over another business's data. See schema-security-fix.sql.
drop policy if exists "self update" on public.users;
