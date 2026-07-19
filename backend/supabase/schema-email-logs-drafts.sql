-- TurnKey: structured send-log for quote/invoice/lifecycle emails, and
-- saved-but-unsent email drafts for the composer's "Save draft" button.
-- Run once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id()/current_business_role().

-- email_logs is distinct from the existing public.emails table: `emails`
-- mirrors the whole connected Gmail thread (inbox, replies, everything);
-- email_logs is a narrower, structured record of business-event sends
-- (quote/invoice/lifecycle emails) tied to a quote_id/invoice_id so the
-- Communication Timeline and reporting can query "what did we send about
-- this quote" without parsing the general mail mirror. Written by the
-- backend (service role) only — /api/email/send inserts one row per send.
create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  customer_id uuid,
  quote_id uuid,
  invoice_id uuid,
  type text not null check (type in ('quote_sent','invoice_sent','job_booked','job_completed','new_lead','quote_reminder','review_request','draft')),
  recipient text not null,
  subject text,
  body text,
  sent_at timestamptz,
  status text not null default 'sent' check (status in ('sent','failed','draft')),
  created_at timestamptz not null default now()
);
alter table public.email_logs enable row level security;
drop policy if exists "read own business" on public.email_logs;
create policy "read own business" on public.email_logs
  for select
  using (business_id = public.current_business_id());
create index if not exists email_logs_business_idx on public.email_logs (business_id, customer_id, created_at desc);

-- email_drafts: composer state saved before sending — client-writable
-- directly (no backend round trip needed for a draft, unlike an actual
-- send which must go through the backend to reach Gmail).
create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  customer_id uuid,
  job_id uuid,
  type text not null check (type in ('quote','invoice')),
  recipient text,
  subject text,
  body text,
  updated_at timestamptz not null default now()
);
alter table public.email_drafts enable row level security;
drop policy if exists "read own business" on public.email_drafts;
create policy "read own business" on public.email_drafts
  for select
  using (business_id = public.current_business_id());
drop policy if exists "manage own business drafts" on public.email_drafts;
create policy "manage own business drafts" on public.email_drafts
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());
