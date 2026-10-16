-- Additive compatibility for installations whose ServiceM8 connection table
-- predates webhook subscription health. Canonical schema already has this
-- column; IF NOT EXISTS preserves both that schema and existing timestamps.
-- No credentials, grants, policies, functions or existing records change.
begin;
alter table public.servicem8_connections
  add column if not exists webhook_subscribed_at timestamptz;
commit;
