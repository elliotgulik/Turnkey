-- TurnKey Customer Profile hub: communication timeline + before/after photos.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id() from fix-rls-recursion.sql.

-- ===== activity_log: one row per timeline event on a customer =====
-- Written to whenever something customer-facing happens (quote sent, job
-- scheduled, invoice sent, note added, and — once connected — every email).
-- This is the single feed the Customer Profile's "Communication timeline"
-- reads from, and the table the email system (next phase) inserts into.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  customer_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  type text not null check (type in (
    'note','quote_sent','quote_viewed','job_scheduled','job_completed',
    'invoice_sent','invoice_paid','follow_up_sent','email_sent','email_received','status_change'
  )),
  summary text not null,
  detail jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists activity_log_customer_idx on public.activity_log (business_id, customer_id, created_at desc);

alter table public.activity_log enable row level security;
drop policy if exists "own business" on public.activity_log;
create policy "own business" on public.activity_log
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

-- ===== attachments: allow tagging photos as before/after for the gallery =====
alter table public.attachments drop constraint if exists attachments_kind_check;
alter table public.attachments add constraint attachments_kind_check
  check (kind in ('customer_photo','job_photo','quote_attachment','before_photo','after_photo'));
