-- TurnKey email integration: OAuth-connected mailboxes (Gmail now, Microsoft
-- 365 later via the same tables/engine) + a client-readable email log that
-- feeds the Customer Profile's communication timeline.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id()/current_business_role().

-- ===== email_accounts: one row per staff member's connected mailbox =====
-- Tokens are AES-256-GCM encrypted by the backend before being written here
-- (see backend/src/crypto.js) — even a leaked service-role key or a stray
-- SQL editor query never sees a usable token, only ciphertext. There is
-- deliberately NO select/insert/update/delete policy for `authenticated` —
-- every read/write goes through the backend's service-role connection.
-- Multiple staff can each connect their own mailbox (Mail.Send-style
-- ownership); one row per (business_id, user_id, provider).
create table if not exists public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail','microsoft')),
  email_address text not null,
  access_token_enc text not null,
  refresh_token_enc text not null,
  token_expiry timestamptz not null,
  scope text,
  last_sync_at timestamptz,
  last_history_id text, -- provider-specific sync cursor (Gmail historyId)
  created_at timestamptz not null default now(),
  unique (business_id, user_id, provider)
);
alter table public.email_accounts enable row level security;
-- No policies granted to authenticated/anon — backend-only via service role.

-- A safe, token-free view the frontend CAN read directly, so the Connections
-- panel can show "connected as you@gmail.com" without a backend round-trip.
create or replace view public.email_accounts_status as
  select id, business_id, user_id, provider, email_address, last_sync_at, created_at
  from public.email_accounts;
alter view public.email_accounts_status set (security_invoker = on);
grant select on public.email_accounts_status to authenticated;
drop policy if exists "own business" on public.email_accounts; -- no-op safety, table has no policies to begin with

-- ===== emails: the CRM's own copy of relevant messages — no secrets, so
-- this one IS directly readable by the client like every other table. =====
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  provider_message_id text not null,
  thread_id text,
  direction text not null check (direction in ('sent','received')),
  from_address text,
  to_addresses text,
  subject text,
  snippet text,
  body_html text,
  body_text text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (account_id, provider_message_id)
);
create index if not exists emails_customer_idx on public.emails (business_id, customer_id, sent_at desc);
create index if not exists emails_thread_idx on public.emails (business_id, thread_id);

alter table public.emails enable row level security;
drop policy if exists "own business" on public.emails;
create policy "own business" on public.emails
  for select
  using (business_id = public.current_business_id());
-- No insert/update/delete for authenticated — emails are only ever written
-- by the backend (service role) after an actual send or a verified sync
-- from the provider, never fabricated client-side.
