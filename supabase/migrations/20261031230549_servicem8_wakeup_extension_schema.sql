-- Repair only the pg_net extension installed by the preceding wake-up migration.
-- No previous networking extension existed; the wake-up is its only consumer.
-- pg_net is non-relocatable, so recreate it in the standard extensions schema.
-- No customer, job, quote, authentication or storage records are affected.
drop extension pg_net;
create extension pg_net with schema extensions;

-- Supabase owns/manages the net schema and its grants. Keep it outside the
-- Data API exposed schemas; do not introduce public wrapper RPCs for it.
-- The scheduler remains restricted to trusted database administration.
revoke all on schema cron from public, anon, authenticated;
revoke all on all functions in schema cron from public, anon, authenticated;
revoke all on all tables in schema cron from public, anon, authenticated;
