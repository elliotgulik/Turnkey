-- Root cause of "Gmail connects successfully but Settings > Connections
-- still shows Not Connected": email_accounts_status (schema-email.sql) was
-- created specifically so "the frontend CAN read directly" (its own
-- comment), and deliberately set `security_invoker = on` so it respects the
-- base table's RLS instead of silently bypassing it (Postgres views default
-- to running as their owner — typically a role that bypasses RLS entirely
-- in Supabase — which would have been a real cross-tenant leak: every
-- OTHER business's connected email address, visible to any authenticated
-- user). That part was correct and deliberate.
--
-- But email_accounts itself has RLS enabled with ZERO policies granted to
-- `authenticated` ("backend-only via service role" — also correct, on its
-- own, for the base table's token columns). Combined, these two correct-
-- in-isolation decisions cancel each other out: security_invoker makes the
-- view inherit the base table's RLS, and the base table's RLS is "deny
-- everyone" — so the view has been returning zero rows for every
-- authenticated frontend query, unconditionally, regardless of whether a
-- connection actually exists. loadEmailAccountStatus() has never once seen
-- a real row: not a caching issue, not a UI refresh-timing issue (a real
-- one of those was also fixed in the previous pass, but was never
-- sufficient on its own) — the query itself has always come back empty.
--
-- Fix: add the missing read policy, scoped to the querying user's own
-- business — the same "read own business" shape used by every other
-- multi-tenant table in this schema (notification_subscriptions,
-- calendar_connections, etc.). The encrypted token columns stay exactly as
-- protected as before even though this technically also makes them
-- selectable on the base table now (not just the token-free view): they're
-- AES-256-GCM ciphertext (backend/src/crypto.js), decryptable only with
-- EMAIL_TOKEN_KEY, which no frontend/authenticated context ever has — this
-- policy does not change what a client can actually DO with that column,
-- only whether the row is visible at all.
--
-- Safe to re-run: idempotent.

drop policy if exists "read own business" on public.email_accounts;
create policy "read own business" on public.email_accounts
  for select
  using (business_id = public.current_business_id());
