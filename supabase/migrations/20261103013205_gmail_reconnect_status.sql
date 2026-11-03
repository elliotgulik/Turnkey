-- Gmail refresh failures require user consent again; expose no credentials.
alter table public.email_accounts
  add column if not exists status text not null default 'ok'
  check (status in ('ok', 'needs_reconnect'));

-- Append to preserve the existing view's column order and invoker RLS.
create or replace view public.email_accounts_status
with (security_invoker = true) as
  select id, business_id, user_id, provider, email_address, last_sync_at, created_at, status
  from public.email_accounts;
grant select (status) on public.email_accounts to authenticated;
revoke all on public.email_accounts_status from public, anon;
grant select on public.email_accounts_status to authenticated;
