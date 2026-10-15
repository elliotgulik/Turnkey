-- Wix + Meta (Facebook/Instagram) Lead Ads webhook ingestion.
-- Run this after schema-leads-business.sql / schema-leads-claim.sql.
-- Safe to re-run: every statement is idempotent.
--
-- Maps an external lead source (a Wix site's generated webhook token, or a
-- Meta Page ID) to the business it belongs to, plus whatever credential is
-- needed to receive/fetch its leads. Service-role only (no RLS policies) —
-- same deliberate pattern already used for public.leads itself (see
-- fix-rls-recursion.sql's note on that table) — only the backend's
-- SUPABASE_SERVICE_ROLE_KEY client ever touches this table.
--
-- Wix: external_id is the SHA-256 hash of a randomly generated token, never
-- the raw token — the raw value is shown once at generation time (see
-- POST /api/connections/wix/connect) and only its hash is stored, so
-- incoming webhook requests are verified by hashing the presented token and
-- comparing, the same way most API-key schemes work. There is nothing to
-- encrypt/decrypt for Wix, since the token is never read back out.
--
-- Meta: external_id is the Facebook Page ID (not secret, Meta's own public
-- identifier — used to look up which business a leadgen webhook event
-- belongs to). token_enc is the long-lived Page Access Token, encrypted at
-- rest with the same AES-256-GCM helper (backend/src/crypto.js) already
-- used for Gmail/Google Calendar OAuth tokens, since the backend must
-- present it back to Meta's Graph API on every lead fetch.
create table if not exists public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  provider text not null check (provider in ('wix','meta')),
  external_id text not null,
  token_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);
create index if not exists lead_sources_business_idx
  on public.lead_sources (business_id, provider);

-- Lets a lead row carry where it came from, and gives webhook ingestion an
-- idempotency key — Wix Automations and Meta's leadgen webhook can both
-- redeliver the same event, and without this a redelivery would create a
-- second, duplicate lead. external_id here is the Wix form submission id /
-- Meta leadgen_id (distinct from lead_sources.external_id above, which
-- identifies the SOURCE, not an individual lead).
alter table public.leads add column if not exists source text;
alter table public.leads add column if not exists external_id text;
create unique index if not exists leads_dedupe_idx
  on public.leads (business_id, source, external_id)
  where external_id is not null;
