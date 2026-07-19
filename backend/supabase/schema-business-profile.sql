-- TurnKey business profiles: per-business name/phone/email/region/logo, used
-- to brand each business's own public booking page instead of a hardcoded
-- placeholder. Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id() / current_business_role() from
-- fix-rls-recursion.sql — run that first if you haven't already.

-- ===== public.businesses: one row per business, id = business_id =====
create table if not exists public.businesses (
  id text primary key,
  name text,
  phone text,
  email text,
  region text,                  -- free-text, e.g. "Auckland, New Zealand" — display + geocoding suffix
  region_lat double precision,  -- auto-geocoded from region (Nominatim), feeds weather
  region_lng double precision,
  logo_url text,
  created_at timestamptz not null default now()
);

alter table public.businesses enable row level security;

-- Public read: booking.html is anonymous and must be able to look up any
-- business's name/phone/email/region/logo by id. Same trust level as what's
-- already shown on the public booking page today (name, rough location).
drop policy if exists "public read" on public.businesses;
create policy "public read" on public.businesses
  for select
  using (true);

-- Owner or manager can create/edit their own business's profile — matches
-- the existing owner/manager gating used for invites (schema-team.sql).
drop policy if exists "owner or manager manage" on public.businesses;
create policy "owner or manager manage" on public.businesses
  for all
  using (
    id = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  )
  with check (
    id = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  );

-- ===== signup trigger: also provision a blank business profile for new owners =====
-- Same body as schema-team.sql's handle_new_user(), with one insert added to
-- the "new owner" branch. The invite-acceptance branch is untouched — staff
-- joining an existing business share that business's existing profile.
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
    insert into public.businesses (id, name)
    values (new.id::text, null)
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

-- ===== business-logos: a PUBLIC bucket, separate from the private
-- turnkey-uploads bucket, because the anonymous booking page needs to
-- display logos without any auth session. Public buckets skip RLS for
-- reads; writes are still scoped to the owning business below. =====
insert into storage.buckets (id, name, public)
values ('business-logos', 'business-logos', true)
on conflict (id) do update set public = true;

-- SELECT is required here even though the bucket is public: the public,
-- RLS-bypassing read path is only the anonymous /storage/v1/object/public/...
-- URL. The authenticated upload path (storage-js upload() with upsert:true)
-- does an internal existence check first, which needs a real SELECT policy
-- to pass, or the whole upsert is rejected as an RLS violation before it
-- ever reaches the insert/update policies below.
drop policy if exists "own business logo select" on storage.objects;
create policy "own business logo select" on storage.objects
  for select
  using (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  );

drop policy if exists "own business logo insert" on storage.objects;
create policy "own business logo insert" on storage.objects
  for insert
  with check (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  );

drop policy if exists "own business logo update" on storage.objects;
create policy "own business logo update" on storage.objects
  for update
  using (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  );

drop policy if exists "own business logo delete" on storage.objects;
create policy "own business logo delete" on storage.objects
  for delete
  using (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = public.current_business_id()
    and public.current_business_role() in ('owner','manager')
  );
