-- The team invite table is public.invites (not team_invites). Keep the
-- existing signup trigger/OID and owner provisioning behavior intact.
create or replace function turnkey_private.handle_new_user()
returns trigger
language plpgsql
security definer set search_path=pg_catalog,public
as $$
declare
  inv public.invites%rowtype;
begin
  if new.email_confirmed_at is not null then
    select * into inv from public.invites
      where lower(trim(email)) = lower(trim(new.email)) and accepted_at is null
      order by created_at, id limit 1 for update;
  end if;

  if inv.id is not null then
    insert into public.users (id, business_id, email, role)
      values (new.id, inv.business_id, new.email, inv.role)
      on conflict (id) do nothing;
    if found then
      update public.invites set accepted_at = now() where id = inv.id;
    end if;
  else
    insert into public.users (id, business_id, email, role)
      values (new.id, new.id::text, new.email, 'owner')
      on conflict (id) do nothing;
    insert into public.businesses (id, name)
      values (new.id::text, null) on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function turnkey_private.claim_confirmed_invite()
returns trigger
language plpgsql
security definer set search_path=pg_catalog,public
as $$
declare
  inv public.invites%rowtype;
  previous_business text;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then
    return new;
  end if;

  -- Only move the provisional owner created by handle_new_user. A repeat
  -- confirmation must never move an existing teammate to another business.
  select business_id into previous_business from public.users
    where id = new.id and business_id = new.id::text and role = 'owner'
    for update;
  if not found then return new; end if;

  select * into inv from public.invites
    where lower(trim(email)) = lower(trim(new.email)) and accepted_at is null
    order by created_at, id limit 1 for update;
  if inv.id is null then return new; end if;

  update public.users set business_id = inv.business_id, role = inv.role
    where id = new.id;
  update public.invites set accepted_at = now() where id = inv.id;

  -- Never remove the invite's business or a business still used by anyone.
  delete from public.businesses b
    where b.id = previous_business and b.id <> inv.business_id
      and not exists (select 1 from public.users u where u.business_id = b.id)
      and not exists (select 1 from public.customers c where c.business_id = b.id)
      and not exists (select 1 from public.jobs j where j.business_id = b.id)
      and not exists (select 1 from public.quotes q where q.business_id = b.id);
  return new;
end;
$$;

revoke all on function turnkey_private.handle_new_user() from public, anon, authenticated;
revoke all on function turnkey_private.claim_confirmed_invite() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function turnkey_private.claim_confirmed_invite();
