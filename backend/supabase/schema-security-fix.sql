-- CRITICAL SECURITY FIX — run this in the Supabase SQL editor immediately.
--
-- The "self update" policy added in schema-app.sql let a signed-in user run
-- PATCH /users?id=eq.<their own id> with a different business_id in the body.
-- The policy's USING clause only checked that the row being touched was
-- their own (id = auth.uid()) — it never restricted what value business_id
-- could be changed to. Every other table's RLS policy (customers, jobs,
-- invoices, quotes, Leads) trusts public.users.business_id as the source of
-- truth, so rewriting that one value let an account "become" any other
-- business and read/write all of its customer, job, and invoice data.
-- Confirmed exploitable and fixed during audit; the test account used to
-- prove it has already been deleted.
--
-- Fix: users have no way to change business_id via the client. Nothing in
-- the app currently updates public.users from the browser, so removing this
-- entirely — rather than trying to carve out an exception — closes the hole
-- with no loss of functionality.

drop policy if exists "self update" on public.users;
