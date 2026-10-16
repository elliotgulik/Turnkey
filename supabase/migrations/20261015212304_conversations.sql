-- General Conversations state is separate from legacy quote/invoice drafts.
-- Writes go through requireBusiness routes so draft send locks cannot be
-- bypassed by a client. Direct reads are limited to the active business/user.
create table if not exists public.conversation_drafts (
  id uuid primary key,
  business_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'draft' check (status in ('draft','sending','sent','unknown')),
  sent_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversation_drafts_owner_idx on public.conversation_drafts(business_id,user_id,updated_at desc);
alter table public.conversation_drafts enable row level security;
revoke all on public.conversation_drafts from anon, authenticated;
grant select on public.conversation_drafts to authenticated;
grant all on public.conversation_drafts to service_role;
drop policy if exists "read own conversation drafts" on public.conversation_drafts;
create policy "read own conversation drafts" on public.conversation_drafts for select to authenticated
  using (business_id = (select public.current_business_id()) and user_id = (select auth.uid()));

create table if not exists public.conversation_stars (
  business_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  thread_key text not null,
  created_at timestamptz not null default now(),
  primary key(business_id,user_id,account_id,thread_key)
);
alter table public.conversation_stars enable row level security;
revoke all on public.conversation_stars from anon, authenticated;
grant select on public.conversation_stars to authenticated;
grant all on public.conversation_stars to service_role;
drop policy if exists "read own conversation stars" on public.conversation_stars;
create policy "read own conversation stars" on public.conversation_stars for select to authenticated
  using (business_id = (select public.current_business_id()) and user_id = (select auth.uid()));
