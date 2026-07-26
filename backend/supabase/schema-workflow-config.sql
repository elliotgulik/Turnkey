-- Business Settings → Workflows: per-business defaults for whether the job
-- checklist, after photos, and customer sign-off are required or purely
-- optional helpers. Mirrors the existing pricing_config column on
-- businesses (one jsonb blob, no join table needed for a handful of
-- booleans). Run this once in the Supabase SQL editor. Safe to re-run.

alter table public.businesses add column if not exists workflow_config jsonb;
