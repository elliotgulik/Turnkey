-- TurnKey: real long-range calendar support, external calendar connections,
-- customizable job checklists, and invoice payment-status tracking.
-- Run once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id()/current_business_role().

-- ===== Calendar connections (Google Calendar OAuth, Apple/iCal subscription feeds) =====
-- Tokens/URLs never read by the client — backend/service-role only, same pattern as
-- email_accounts. sync_status + last_synced_at drive the Connections UI so a business
-- can see whether their calendar is actually syncing, not just "connected".
-- ical_url defaults to '' (not null) for the same reason service_key does on
-- checklist_templates above: Postgres treats every NULL as distinct from every
-- other NULL, so a nullable ical_url would defeat ON CONFLICT for Google
-- connections (which never have one) — reconnecting would insert a duplicate
-- row instead of updating the existing one. '' is a safe sentinel because a
-- real feed URL is never empty.
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid not null,
  provider text not null check (provider in ('google','ical')),
  encrypted_tokens text,      -- google: AES-256-GCM encrypted OAuth token JSON (null for ical)
  ical_url text not null default '', -- ical: the subscribed feed URL ('' for google)
  sync_status text not null default 'pending' check (sync_status in ('pending','ok','error')),
  sync_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, user_id, provider, ical_url)
);
alter table public.calendar_connections enable row level security;
-- All writes (connect/disconnect/sync) go through the backend using the
-- service-role key, which bypasses RLS entirely — these policies only govern
-- what the client can SELECT directly. Every team member can see their own
-- connection (they're the one who'll click Connect/Disconnect for it);
-- owner/manager can additionally see everyone's, for admin visibility (e.g.
-- disconnecting a departed teammate's stale calendar). encrypted_tokens is
-- still never exposed to the client — see the status view below.
drop policy if exists "read own connection" on public.calendar_connections;
create policy "read own connection" on public.calendar_connections
  for select
  using (business_id = public.current_business_id() and user_id = auth.uid());
drop policy if exists "owner or manager read all" on public.calendar_connections;
create policy "owner or manager read all" on public.calendar_connections
  for select
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));

create or replace view public.calendar_connections_status as
  select id, business_id, user_id, provider, ical_url, sync_status, sync_error, last_synced_at, created_at
  from public.calendar_connections;
alter view public.calendar_connections_status set (security_invoker = on);

-- ===== Calendar events pulled in from external calendars (busy-time blocking) =====
create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid not null,
  connection_id uuid references public.calendar_connections(id) on delete cascade,
  external_id text,
  title text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  busy_status text not null default 'busy' check (busy_status in ('busy','free')),
  created_at timestamptz not null default now(),
  unique (connection_id, external_id)
);
alter table public.calendar_events enable row level security;
drop policy if exists "read own business" on public.calendar_events;
create policy "read own business" on public.calendar_events
  for select
  using (business_id = public.current_business_id());
-- Writes come from the backend via service role only (sync jobs) — no client insert/update policy.
create index if not exists calendar_events_business_time_idx on public.calendar_events (business_id, start_time, end_time);

-- ===== Per-business, per-service customizable job checklists =====
-- service_key '' (empty string, not null) = the default/fallback checklist used
-- when a job's service has no dedicated template. Replaces the old hardcoded
-- 6-step SOP_STEPS constant. Deliberately NOT NULL: Postgres unique constraints
-- treat every NULL as distinct from every other NULL, so a nullable service_key
-- would silently defeat the upsert-based self-heal (each "seed the default row"
-- upsert would insert a new row instead of hitting ON CONFLICT) — the empty
-- string sentinel keeps ON CONFLICT (business_id, service_key) reliable.
create table if not exists public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  service_key text not null default '',
  name text not null,
  steps jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (business_id, service_key)
);
alter table public.checklist_templates enable row level security;
drop policy if exists "read own business" on public.checklist_templates;
create policy "read own business" on public.checklist_templates
  for select
  using (business_id = public.current_business_id());
drop policy if exists "owner or manager write" on public.checklist_templates;
create policy "owner or manager write" on public.checklist_templates
  for insert
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
drop policy if exists "owner or manager update" on public.checklist_templates;
create policy "owner or manager update" on public.checklist_templates
  for update
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
drop policy if exists "owner or manager delete" on public.checklist_templates;
create policy "owner or manager delete" on public.checklist_templates
  for delete
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));

-- ===== Invoice payment-status tracking (architecture for Stripe/payment links —
-- the columns are used today for manual status tracking regardless of Stripe). =====
alter table public.invoices add column if not exists payment_status text not null default 'draft'
  check (payment_status in ('draft','sent','viewed','approved','paid','overdue'));
alter table public.invoices add column if not exists payment_date timestamptz;
alter table public.invoices add column if not exists payment_method text;
alter table public.invoices add column if not exists payment_link_url text;
alter table public.invoices add column if not exists due_date date;

-- ===== Per-business editable lifecycle/automation email copy =====
-- One row per (business_id, key). Distinct from email_templates (quote/invoice
-- documents) — these are short transactional notices, not full documents.
create table if not exists public.lifecycle_emails (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  key text not null check (key in (
    'new_lead','quote_sent','quote_reminder','job_booked',
    'day_before_reminder','job_completed','invoice_overdue','review_request'
  )),
  enabled boolean not null default true,
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now(),
  unique (business_id, key)
);
alter table public.lifecycle_emails enable row level security;
drop policy if exists "read own business" on public.lifecycle_emails;
create policy "read own business" on public.lifecycle_emails
  for select
  using (business_id = public.current_business_id());
drop policy if exists "owner or manager write" on public.lifecycle_emails;
create policy "owner or manager write" on public.lifecycle_emails
  for insert
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
drop policy if exists "owner or manager update" on public.lifecycle_emails;
create policy "owner or manager update" on public.lifecycle_emails
  for update
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));

-- ===== Sent-automation log — prevents double-sending day-before reminders /
-- overdue nags when the /api/automations/run-due sweep runs more than once a day. =====
create table if not exists public.lifecycle_email_log (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  job_id uuid,
  key text not null,
  sent_at timestamptz not null default now(),
  unique (business_id, job_id, key)
);
alter table public.lifecycle_email_log enable row level security;
drop policy if exists "read own business" on public.lifecycle_email_log;
create policy "read own business" on public.lifecycle_email_log
  for select
  using (business_id = public.current_business_id());
