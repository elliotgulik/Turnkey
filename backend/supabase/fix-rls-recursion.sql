-- Fix: infinite recursion (42P17) in public.users RLS.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
--
-- ROOT CAUSE: two policies added in schema-team.sql — "same business select"
-- and "owner remove staff" on public.users — query public.users from inside
-- a policy that protects public.users. A policy on table T cannot query T to
-- decide access to T: Postgres has to re-run the same policy to answer the
-- subquery, forever, which is exactly what error 42P17 reports.
--
-- Every other table's policy (customers, jobs, invoices, quotes, "Leads",
-- attachments, storage.objects, invites) subqueries public.users too — not
-- self-referentially, but evaluating that subquery still requires running a
-- SELECT against public.users, which invokes users' own broken policy. That
-- is why customers/jobs/invoices/users all failed together: the recursion in
-- users poisons every table that depends on it for business_id scoping.
-- public.leads (lowercase) was never affected — it has no RLS policies at
-- all (service-role only, by design).
--
-- FIX: two security-definer helper functions. Their internal lookup against
-- public.users runs as the function owner, not the calling role, so it does
-- not re-enter users' RLS policies — no recursion, by construction. Every
-- policy that used to embed a raw `(select ... from public.users where
-- id = auth.uid())` subquery is rewritten to call these instead, so this bug
-- class can't resurface piecemeal later.

create or replace function public.current_business_id()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select business_id from public.users where id = auth.uid()
$$;

create or replace function public.current_business_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.users where id = auth.uid()
$$;

revoke all on function public.current_business_id() from public;
revoke all on function public.current_business_role() from public;
grant execute on function public.current_business_id() to authenticated, anon;
grant execute on function public.current_business_role() to authenticated, anon;

-- ===== public.users — the actual recursion fix =====
drop policy if exists "self select" on public.users;
drop policy if exists "same business select" on public.users;
create policy "same business select" on public.users
  for select
  using (id = auth.uid() or business_id = public.current_business_id());

-- "self update profile" (id = auth.uid(), no subquery) was never recursive —
-- recreated here only so this file is a complete, standalone fix.
drop policy if exists "self update profile" on public.users;
create policy "self update profile" on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "owner remove staff" on public.users;
create policy "owner remove staff" on public.users
  for delete
  using (
    business_id = public.current_business_id()
    and public.current_business_role() = 'owner'
    and id <> auth.uid()
  );

-- ===== every other table — same rewrite, for consistency and defense in depth =====
drop policy if exists "own business" on public.customers;
create policy "own business" on public.customers
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.jobs;
create policy "own business" on public.jobs
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.invoices;
create policy "own business" on public.invoices
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.quotes;
create policy "own business" on public.quotes
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public."Leads";
create policy "own business" on public."Leads"
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business" on public.attachments;
create policy "own business" on public.attachments
  for all
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "own business select" on storage.objects;
create policy "own business select" on storage.objects
  for select
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = public.current_business_id()
  );

drop policy if exists "own business insert" on storage.objects;
create policy "own business insert" on storage.objects
  for insert
  with check (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = public.current_business_id()
  );

drop policy if exists "own business update" on storage.objects;
create policy "own business update" on storage.objects
  for update
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = public.current_business_id()
  );

drop policy if exists "own business delete" on storage.objects;
create policy "own business delete" on storage.objects
  for delete
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = public.current_business_id()
  );

drop policy if exists "invite by role" on public.invites;
create policy "invite by role" on public.invites
  for insert
  with check (
    business_id = public.current_business_id()
    and (
      public.current_business_role() = 'owner'
      or (public.current_business_role() = 'manager' and role = 'technician')
    )
  );

drop policy if exists "view invites by role" on public.invites;
create policy "view invites by role" on public.invites
  for select
  using (
    business_id = public.current_business_id()
    and (
      public.current_business_role() = 'owner'
      or (public.current_business_role() = 'manager' and role = 'technician')
    )
  );

drop policy if exists "cancel invites by role" on public.invites;
create policy "cancel invites by role" on public.invites
  for delete
  using (
    business_id = public.current_business_id()
    and (
      public.current_business_role() = 'owner'
      or (public.current_business_role() = 'manager' and role = 'technician')
    )
  );

-- Column-level grant for self-service profile edits (name/phone only) is
-- unaffected by this fix, but reissued here for idempotency since this file
-- is meant to be a complete standalone repair.
revoke update on public.users from authenticated;
grant update (name, phone) on public.users to authenticated;
