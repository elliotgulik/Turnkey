-- TurnKey: owner-facing notification preferences (distinct from
-- lifecycle_emails, which are customer-facing). Run once in the Supabase
-- SQL editor. Safe to re-run: idempotent.

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  event text not null check (event in (
    'new_lead','quote_accepted','job_booked','job_tomorrow','invoice_overdue','payment_received','review_requested'
  )),
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,   -- architecture only — no SMS provider wired up yet
  push_enabled boolean not null default false,  -- architecture only — no push provider wired up yet
  notify_email text, -- defaults to the business's own email if left blank
  updated_at timestamptz not null default now(),
  unique (business_id, event)
);
alter table public.notification_preferences enable row level security;
drop policy if exists "read own business" on public.notification_preferences;
create policy "read own business" on public.notification_preferences
  for select
  using (business_id = public.current_business_id());
drop policy if exists "owner or manager write" on public.notification_preferences;
create policy "owner or manager write" on public.notification_preferences
  for insert
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
drop policy if exists "owner or manager update" on public.notification_preferences;
create policy "owner or manager update" on public.notification_preferences
  for update
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
