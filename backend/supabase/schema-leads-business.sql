-- Multi-tenant fix for the public lead-intake table.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
--
-- Today `public.leads` (the jsonb-blob inbox the Express backend's public
-- POST /api/leads writes to) has no business_id at all — every business's
-- CRM polling /api/leads/pending would receive every OTHER business's
-- customer submissions too. This adds the column the backend now stamps on
-- write and filters on read.

alter table public.leads add column if not exists business_id text;

create index if not exists leads_business_pending_idx on public.leads (business_id, created_at)
  where acked_at is null;

-- Note: public."Leads" (capital L, defined in schema-app.sql) is a separate,
-- already-RLS'd table that nothing in this codebase reads or writes. It is
-- unused/superseded by this business_id column on the lowercase `leads`
-- table — left in place undropped since we can't confirm nothing external
-- references it, but it is not part of the lead-intake pipeline.
