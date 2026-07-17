-- Supabase schema for TurnKey backend (STORAGE=supabase)
-- Run in Supabase SQL editor or: supabase db push

create table if not exists public.crm_state (
  id text primary key default 'default',
  state jsonb not null,
  saved_at bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  acked_at timestamptz
);

create index if not exists leads_pending_idx on public.leads (created_at)
  where acked_at is null;

alter table public.crm_state enable row level security;
alter table public.leads enable row level security;

-- Backend uses service role key — no public policies needed for MVP.
-- Do not expose service role key to the browser.
