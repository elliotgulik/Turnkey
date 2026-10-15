-- ServiceM8 integration: connections, object mapping, outbound handoff
-- tracking, and inbound webhook durability/dedup.
-- Run this after schema-app.sql (customers/jobs) and schema-leads-claim.sql.
-- Safe to re-run: every statement is idempotent.
--
-- Service-role only (no RLS policies) — same deliberate pattern already
-- used for public.leads and public.lead_sources (see fix-rls-recursion.sql's
-- note on that table). Only the backend's SUPABASE_SERVICE_ROLE_KEY client
-- ever touches these; nothing here is read directly by the CRM frontend via
-- a user-scoped Supabase session.

-- Per-business ServiceM8 connection. Exactly one of api_key_enc or
-- (access_token_enc + refresh_token_enc) is populated, matching the two
-- auth paths ServiceM8 documents (developer.servicem8.com/docs/authentication):
-- a Private API Key (single account, no Development Partner registration)
-- or OAuth 2.0 (required for multi-tenant SaaS + webhooks). All secrets
-- encrypted at rest via the existing AES-256-GCM helper (backend/src/crypto.js),
-- same as Gmail/Google Calendar tokens.
-- webhook_token_hash: SHA-256 hash of a per-business random token embedded
-- in the callback URL we register with ServiceM8
-- (/api/servicem8/webhook/:token) — NOT a secret ServiceM8 presents to us,
-- one we choose. It exists because ServiceM8's webhook payload carries no
-- account/business identifier at all (confirmed: the entry only has an
-- object uuid and changed field names), so with more than one connected
-- business there would otherwise be no way to know which one's credential
-- to use to re-fetch the changed object. Hashed rather than encrypted,
-- same reasoning and shape as lead_sources' Wix token (schema-lead-
-- webhooks.sql) — AES-GCM ciphertext isn't deterministic, so it can't be
-- looked up by exact match the way a hash can; the raw token is shown once
-- at generation/subscribe time and never needs to be read back.
create table if not exists public.servicem8_connections (
  id uuid primary key default gen_random_uuid(),
  business_id text not null unique,
  auth_mode text not null check (auth_mode in ('api_key','oauth')),
  api_key_enc text,
  access_token_enc text,
  refresh_token_enc text,
  token_expiry timestamptz,
  scope text,
  account_uuid text,
  account_name text,
  webhook_token_hash text,
  webhook_subscribed_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists servicem8_connections_webhook_lookup_idx
  on public.servicem8_connections (webhook_token_hash) where webhook_token_hash is not null;

-- Maps a TurnKey record to its ServiceM8 counterpart so a repeated handoff
-- (e.g. a "Won" event firing twice) updates/reuses the existing ServiceM8
-- record instead of creating a duplicate. local_type uses TurnKey's own
-- vocabulary ('customer','job'); sm8_type uses ServiceM8's
-- (developer.servicem8.com/docs/rest-overview: Client/Customer -> Company).
create table if not exists public.servicem8_object_map (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  local_type text not null check (local_type in ('customer','job')),
  local_id uuid not null,
  sm8_type text not null check (sm8_type in ('company','job')),
  sm8_uuid text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, local_type, local_id, sm8_type),
  unique (business_id, sm8_type, sm8_uuid)
);
create index if not exists servicem8_object_map_business_idx
  on public.servicem8_object_map (business_id);

-- Outbound handoff tracking (TurnKey Won -> ServiceM8 Company+Job): one row
-- per TurnKey job, upserted on (business_id, job_id) so a repeated Won
-- event is a safe idempotent retry rather than a duplicate ServiceM8 job.
-- Also the backing data for the Connections card's "pending/failed
-- transfers" list and the manual-retry action the spec asks for.
create table if not exists public.servicem8_handoffs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','synced','failed')),
  sm8_company_uuid text,
  sm8_job_uuid text,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, job_id)
);
create index if not exists servicem8_handoffs_status_idx
  on public.servicem8_handoffs (business_id, status);

-- Inbound webhook durability + dedup. ServiceM8's webhook payload carries
-- only an object uuid and the names of fields that changed — never the new
-- values (developer.servicem8.com/docs/webhooks-overview) — so processing
-- always means "go re-fetch object_uuid via our own authenticated REST
-- call", recorded here so a redelivered event (ServiceM8 retries 4xx/5xx
-- for up to 72h) is a no-op, and a failed fetch/process is visible and
-- retryable instead of silently lost.
create table if not exists public.servicem8_webhook_events (
  id uuid primary key default gen_random_uuid(),
  business_id text,
  object_type text not null,
  object_uuid text not null,
  changed_fields jsonb,
  event_time timestamptz,
  status text not null default 'pending' check (status in ('pending','processed','failed','ignored')),
  attempts int not null default 0,
  last_error text,
  raw_payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists servicem8_webhook_events_pending_idx
  on public.servicem8_webhook_events (received_at) where status = 'pending';
create index if not exists servicem8_webhook_events_business_idx
  on public.servicem8_webhook_events (business_id);
