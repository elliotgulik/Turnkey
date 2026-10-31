-- Record the one-time historical ServiceM8 calendar seed. Normal calendar
-- navigation reads saved calendar_events and webhook updates; it does not
-- repeat the full remote import.
begin;
alter table public.servicem8_connections
  add column if not exists dispatch_seeded_at timestamptz;
commit;
