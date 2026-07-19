-- TurnKey email templates: per-business, editable quote/invoice email content
-- (separate from docTemplate, which only styles the attached/embedded PDF
-- look — this governs the actual email subject/body sent through Gmail).
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id()/current_business_role().

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  type text not null check (type in ('quote','invoice')),
  subject text not null,
  greeting text not null,
  body text not null,
  cta text,                  -- quote: call-to-action line ("Reply to accept" etc.)
  payment_instructions text, -- invoice: how/where to pay
  signature text not null,
  updated_at timestamptz not null default now(),
  unique (business_id, type)
);

alter table public.email_templates enable row level security;

drop policy if exists "read own business" on public.email_templates;
create policy "read own business" on public.email_templates
  for select
  using (business_id = public.current_business_id());

drop policy if exists "owner or manager write" on public.email_templates;
create policy "owner or manager write" on public.email_templates
  for insert
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));

drop policy if exists "owner or manager update" on public.email_templates;
create policy "owner or manager update" on public.email_templates
  for update
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
