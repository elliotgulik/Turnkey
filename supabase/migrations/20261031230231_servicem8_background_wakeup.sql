-- Keep the existing Render worker available independently of an open CRM tab.
-- This calls only the public health endpoint; no credentials or customer data
-- leave Postgres. The backend owns tenant-scoped durable reconciliation/retries.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Restrict application access where the current role owns the objects.
-- Supabase owns net and may retain platform grants; do not expose net through
-- the Data API or create public wrapper RPCs. cron is administration-only.
revoke all on schema cron, net from public, anon, authenticated;
revoke all on all functions in schema cron, net from public, anon, authenticated;
revoke all on all tables in schema cron, net from public, anon, authenticated;
revoke all on all sequences in schema cron, net from public, anon, authenticated;

-- Named schedules are updated in place, making reapplication idempotent.
select cron.schedule(
  'turnkey-servicem8-background-wakeup',
  '*/10 * * * *',
  $job$select net.http_get(
    url := 'https://turnkeynova.onrender.com/api/health',
    timeout_milliseconds := 60000
  );$job$
);
