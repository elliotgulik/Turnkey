-- TurnKey team management: roles, invites, job assignment.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.

-- ===== public.users: add profile + role =====
alter table public.users add column if not exists role text not null default 'owner';
alter table public.users add column if not exists name text;
alter table public.users add column if not exists phone text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_check') then
    alter table public.users add constraint users_role_check check (role in ('owner','manager','technician'));
  end if;
end $$;

-- ===== invites: a pending record a staff member's own signup consumes by email =====
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  email text not null,
  role text not null check (role in ('owner','manager','technician')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

alter table public.invites enable row level security;

-- Owner can invite any role; manager can only invite technicians.
drop policy if exists "invite by role" on public.invites;
create policy "invite by role" on public.invites
  for insert
  with check (
    business_id = (select business_id from public.users where id = auth.uid())
    and (
      (select role from public.users where id = auth.uid()) = 'owner'
      or ((select role from public.users where id = auth.uid()) = 'manager' and role = 'technician')
    )
  );

-- Owner sees/cancels all invites for their business; manager sees/cancels only the technician invites.
drop policy if exists "view invites by role" on public.invites;
create policy "view invites by role" on public.invites
  for select
  using (
    business_id = (select business_id from public.users where id = auth.uid())
    and (
      (select role from public.users where id = auth.uid()) = 'owner'
      or ((select role from public.users where id = auth.uid()) = 'manager' and role = 'technician')
    )
  );

drop policy if exists "cancel invites by role" on public.invites;
create policy "cancel invites by role" on public.invites
  for delete
  using (
    business_id = (select business_id from public.users where id = auth.uid())
    and (
      (select role from public.users where id = auth.uid()) = 'owner'
      or ((select role from public.users where id = auth.uid()) = 'manager' and role = 'technician')
    )
  );

-- ===== signup trigger: attach to an inviter's business if a pending invite matches, else become a new business owner =====
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
begin
  select * into inv from public.invites
    where email = new.email and accepted_at is null
    order by created_at asc limit 1;

  if inv.id is not null then
    insert into public.users (id, business_id, email, role)
    values (new.id, inv.business_id, new.email, inv.role)
    on conflict (id) do nothing;
    update public.invites set accepted_at = now() where id = inv.id;
  else
    insert into public.users (id, business_id, email, role)
    values (new.id, new.id::text, new.email, 'owner')
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

-- ===== jobs: real FK for who a job is assigned to (alongside the existing tech name in details) =====
alter table public.jobs add column if not exists assigned_to uuid references public.users(id) on delete set null;

-- ===== public.users RLS: teammates can see each other; self-update stays column-restricted =====
drop policy if exists "self select" on public.users;
drop policy if exists "same business select" on public.users;
create policy "same business select" on public.users
  for select
  using (business_id = (select business_id from public.users where id = auth.uid()));

-- Staff can update their own name/phone only (column-level grant, not business_id/role/id).
revoke update on public.users from authenticated;
grant update (name, phone) on public.users to authenticated;
drop policy if exists "self update profile" on public.users;
create policy "self update profile" on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Role changes go through this function only — NOT a direct column grant.
-- Reason: RLS UPDATE policies on the same table are OR'd together. If `role`
-- were grantable to `authenticated` at all, a technician's own-row update
-- would already satisfy "self update profile" (id = auth.uid()) regardless
-- of the separate owner-only policy, letting them rewrite their own role —
-- the same class of bug the business_id takeover fix closed earlier. A
-- security-definer function sidesteps grants and policies entirely.
create or replace function public.set_staff_role(target_id uuid, new_role text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  caller_role text;
  caller_business text;
  target_business text;
begin
  select role, business_id into caller_role, caller_business from public.users where id = auth.uid();
  if caller_role is distinct from 'owner' then
    raise exception 'only an owner can change staff roles';
  end if;
  if new_role not in ('owner','manager','technician') then
    raise exception 'invalid role';
  end if;
  select business_id into target_business from public.users where id = target_id;
  if target_business is distinct from caller_business then
    raise exception 'staff member not in your business';
  end if;
  update public.users set role = new_role where id = target_id;
end;
$$;
revoke all on function public.set_staff_role(uuid, text) from public;
grant execute on function public.set_staff_role(uuid, text) to authenticated;

drop policy if exists "owner remove staff" on public.users;
create policy "owner remove staff" on public.users
  for delete
  using (
    business_id = (select business_id from public.users where id = auth.uid())
    and (select role from public.users where id = auth.uid()) = 'owner'
    and id <> auth.uid()
  );
