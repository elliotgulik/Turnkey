-- email_accounts already exists (backend/supabase/schema-email.sql) with
-- id/business_id/user_id/provider/email_address/access_token_enc/
-- refresh_token_enc/token_expiry/scope/created_at — everything a Gmail-
-- OAuth audit asked to verify, except updated_at, which this adds. Tokens
-- stay encrypted at rest (access_token_enc/refresh_token_enc, AES-256-GCM —
-- see backend/src/crypto.js), not the plaintext access_token/refresh_token
-- column names sometimes expected: even a leaked service-role key or a
-- stray SQL editor query should never hand over a live, usable Gmail token.
--
-- Safe to re-run: idempotent.

alter table public.email_accounts add column if not exists updated_at timestamptz not null default now();
