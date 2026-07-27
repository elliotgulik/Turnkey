-- Best-effort reconstruction of public.jobs / public.quotes / public.invoices
-- — the three most-used tables in TurnKey that have NO CREATE TABLE anywhere
-- in this repo. They were originally hand-created in the Supabase dashboard
-- before any SQL here existed; every file under backend/supabase/ only ever
-- ALTERs them. Without this file, a fresh clone of this repo cannot stand up
-- a working database — see supabase/migrations/README.md for the full story.
--
-- ===== HOW THIS WAS RECONSTRUCTED — read before trusting it =====
-- Every column below was extracted from one of two evidence sources, never
-- guessed:
--   (a) an `alter table ... add column` statement somewhere in
--       backend/supabase/*.sql (grepped and read in full), or
--   (b) the exact payload objects index.html/backend actually send to
--       .insert()/.update() on these tables (syncRecordToSupabase() in
--       index.html, and the Stripe webhook handler in backend/src/index.js)
--       — Supabase rejects an insert/update referencing a column that
--       doesn't exist, so every key in those payloads is a real column.
-- Types are inferred from how each column is used (e.g. `quote_id`/`job_id`
-- are `text`, NOT `uuid` — schema-scheduling.sql already discovered and
-- documented this the hard way; do not "fix" this without reading its
-- warning comment below first).
--
-- ONE COLUMN is not directly confirmed by either source: invoices.created_at.
-- Every sibling table has one and nothing in the app contradicts it, but no
-- code was found reading or writing it, so it's marked (UNCONFIRMED) below.
-- Verify this file's exact column list against Supabase Studio's own table
-- editor for jobs/quotes/invoices before relying on it for disaster
-- recovery or a new environment — this is the best reconstruction the
-- evidence in this repo supports, not a guaranteed byte-for-byte mirror of
-- production.
--
-- ===== SAFE TO RUN AGAINST THE EXISTING PRODUCTION DATABASE =====
-- Every statement is `if not exists` / idempotent. Against a database where
-- these tables already exist (i.e. your real production database), this
-- file does nothing. It only matters for a genuinely fresh environment.
--
-- ===== PREREQUISITES =====
-- Run backend/supabase/schema-app.sql first (creates public.customers,
-- public.users, the handle_new_user() trigger) and
-- backend/supabase/fix-rls-recursion.sql (creates the
-- current_business_id()/current_business_role() helper functions the RLS
-- policies below call). This file does not recreate those.

-- ===== jobs =====
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  customer_id uuid references public.customers(id) on delete set null,
  -- text, not uuid — schema-import-wizard.sql/schema-import-servicem8.sql
  -- both write it as `new_id::text`. No FK constraint exists; see
  -- schema-scheduling.sql's own note on why a blind type-change is unsafe
  -- against live data before this repo has direct DB access to verify it.
  quote_id text,
  assigned_to uuid references public.users(id) on delete set null,
  status text not null default 'new',
  scheduled_date date,
  -- Flexible per-job data: tech name, recurrence, day-of status lifecycle,
  -- Google Calendar event id, weather snapshot, job-specific notes —
  -- everything not promoted to a real column. See syncRecordToSupabase()
  -- in index.html for the full shape written here.
  details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- ===== quotes =====
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  -- text, not uuid — same split as jobs.quote_id/invoices.job_id. Actually
  -- holds a customers.id value (cast where needed — see
  -- get_public_quote()/respond_to_public_quote() in schema-public-quote.sql).
  lead_id text,
  amount numeric,
  status text not null default 'sent',
  created_at timestamptz not null default now(),
  -- Unguessable per-quote share link id — added later (schema-public-quote.sql)
  -- but included in the base table here since every quote needs one.
  public_token uuid not null default gen_random_uuid(),
  -- Set once by POST /api/notifications/quote-viewed when the customer
  -- first opens their public quote link — not a status value, a timestamp.
  viewed_at timestamptz
);

create unique index if not exists quotes_public_token_idx on public.quotes (public_token);

-- ===== invoices =====
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  -- text, not uuid — see jobs.quote_id note above, same underlying issue.
  job_id text,
  amount numeric,
  -- Simple boolean flag, distinct from payment_status (which carries the
  -- full draft/sent/paid lifecycle text) — both are set together on every
  -- write (see syncRecordToSupabase() and the Stripe webhook handler).
  paid boolean not null default false,
  payment_status text not null default 'draft',
  payment_date timestamptz,
  payment_method text,
  payment_link_url text,
  due_date date,
  -- (UNCONFIRMED) — no code was found reading or writing this column
  -- directly, unlike every other column here. Included because every
  -- sibling table has one and nothing contradicts it existing, but verify
  -- against the live table before treating this file as authoritative.
  created_at timestamptz not null default now()
);

-- ===== indexes — mirrors backend/supabase/schema-scheduling.sql so a fresh
-- environment gets these without needing that file too. =====
create index if not exists jobs_business_idx on public.jobs (business_id);
create index if not exists jobs_business_scheduled_idx on public.jobs (business_id, scheduled_date);
create index if not exists jobs_customer_idx on public.jobs (customer_id);
create index if not exists jobs_assigned_to_idx on public.jobs (assigned_to);
create index if not exists invoices_business_idx on public.invoices (business_id);
create index if not exists invoices_job_idx on public.invoices (job_id);
create index if not exists quotes_business_idx on public.quotes (business_id);

-- ===== RLS — current policy shape (post fix-rls-recursion.sql), not the
-- original schema-app.sql version, which had a recursion bug. =====
alter table public.jobs enable row level security;
alter table public.quotes enable row level security;
alter table public.invoices enable row level security;

drop policy if exists "own business" on public.jobs;
create policy "own business" on public.jobs
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.quotes;
create policy "own business" on public.quotes
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.invoices;
create policy "own business" on public.invoices
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());
