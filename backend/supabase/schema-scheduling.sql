-- Scheduling system hardening: closes the gap where the base `jobs` table
-- was never captured in a migration (only ALTERs against a table created ad
-- hoc in the Supabase dashboard — see schema-app.sql/schema-team.sql), adds
-- the indexes every other business_id-scoped table already has, and adds a
-- real auto-maintained updated_at (the ones on other tables default to
-- now() at insert but nothing ever refreshes them on update).
-- Run this after schema-app.sql and schema-team.sql. Safe to re-run: every
-- statement is idempotent (if not exists / create or replace).
--
-- ===== Canonical `jobs` column list (documented here since no CREATE TABLE
-- for it exists anywhere in this repo) =====
-- id            uuid primary key
-- business_id   text            -- RLS scope (schema-app.sql)
-- customer_id   uuid            -- references customers(id) (schema-app.sql)
-- quote_id      text            -- NOT uuid — schema-import-wizard.sql and
--                                   schema-import-servicem8.sql both write it
--                                   as `new_id::text`, so the underlying
--                                   column is text. No FK constraint exists;
--                                   see the note below before adding one.
-- assigned_to   uuid            -- references users(id) (schema-team.sql)
-- status        text            -- 'new'|'quoted'|'won'|'scheduled'|'completed'|'paid'|'cancelled' — no CHECK constraint
-- scheduled_date date           -- date only, no time-of-day column exists
-- details       jsonb           -- flexible per-job data (tech name, recurrence,
--                                   day-of status lifecycle, Google Calendar
--                                   event id, weather snapshot, job-specific
--                                   notes — everything not promoted to a real column)
-- created_at    timestamptz
--
-- We deliberately do NOT add travel_time/calendar_colour columns:
-- - calendar_colour is correctly DERIVED from status client-side
--   (JOB_STATUS_CAL_COLOR in index.html) — storing a second copy would be
--   exactly the kind of duplicated, driftable state this migration is
--   trying to avoid.
-- - travel_time has no producer anywhere in the app (no routing/geocoding
--   integration computes it) — adding a column nothing ever populates would
--   just be silent dead schema. It belongs in `details` the day a real
--   travel-time calculation exists, same as everything else in that jsonb.
alter table public.jobs add column if not exists updated_at timestamptz not null default now();

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

-- ===== Indexes — every other business_id-scoped table in this schema
-- (calendar_events, activity_log, email_logs, leads, import_records) already
-- has one; jobs/customers/invoices/quotes never did. RLS filters every
-- query by business_id, and the calendar loads the full jobs table per
-- business on every page load, so this is the single highest-value index. =====
create index if not exists jobs_business_idx on public.jobs (business_id);
create index if not exists jobs_business_scheduled_idx on public.jobs (business_id, scheduled_date);
create index if not exists jobs_customer_idx on public.jobs (customer_id);
create index if not exists jobs_assigned_to_idx on public.jobs (assigned_to);

create index if not exists customers_business_idx on public.customers (business_id);
create index if not exists invoices_business_idx on public.invoices (business_id);
create index if not exists invoices_job_idx on public.invoices (job_id);
create index if not exists quotes_business_idx on public.quotes (business_id);

-- ===== Known gap, NOT fixed here — read before acting =====
-- jobs.quote_id and invoices.job_id are both stored as `text`, not `uuid`,
-- so neither has (or can have, without a type change) a real foreign key
-- constraint back to quotes.id/jobs.id. Retyping a live column on a
-- production table this environment has no direct database access to is
-- too risky to do blind — a single row where the text value doesn't parse
-- as a uuid, or doesn't match an existing quotes/jobs row, would break the
-- migration or silently orphan data. Before attempting this, run:
--
--   select count(*) from public.jobs
--     where quote_id is not null and quote_id !~ '^[0-9a-f-]{36}$';
--   select count(*) from public.jobs j
--     where j.quote_id is not null
--       and not exists (select 1 from public.quotes q where q.id::text = j.quote_id);
--   select count(*) from public.invoices i
--     where i.job_id is not null
--       and not exists (select 1 from public.jobs j where j.id::text = i.job_id);
--
-- If all three return 0, it's safe to alter both columns to uuid and add
-- real `references` constraints. If not, the offending rows need cleaning
-- up first — do not run a blind type-change migration against live data.
