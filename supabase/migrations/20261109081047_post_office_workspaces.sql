-- LOCAL preparation only; do not apply to the live TurnKey database.
-- The CLI was unavailable when preparing this migration.
create table public.post_office_workspaces (
  business_id text primary key references public.businesses(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.post_office_workspaces enable row level security;
revoke all on public.post_office_workspaces from public, anon, authenticated;
grant select, insert, update, delete on public.post_office_workspaces to authenticated;

-- The trusted users table identifies the business; user-editable JWT metadata
-- must never qualify an otherwise unrelated business for this workspace.
create policy post_office_read on public.post_office_workspaces
  for select to authenticated using (
    business_id = (select public.current_business_id())
    and exists (
      select 1 from public.users u
      where u.business_id = post_office_workspaces.business_id
        and lower(u.email) = 'jackie@thepostoffice.co.nz'
    )
  );

create policy post_office_insert on public.post_office_workspaces
  for insert to authenticated with check (
    business_id = (select public.current_business_id())
    and (select public.current_business_role()) in ('owner', 'manager')
    and exists (
      select 1 from public.users u
      where u.business_id = post_office_workspaces.business_id
        and lower(u.email) = 'jackie@thepostoffice.co.nz'
    )
  );

create policy post_office_update on public.post_office_workspaces
  for update to authenticated using (
    business_id = (select public.current_business_id())
    and (select public.current_business_role()) in ('owner', 'manager')
    and exists (
      select 1 from public.users u
      where u.business_id = post_office_workspaces.business_id
        and lower(u.email) = 'jackie@thepostoffice.co.nz'
    )
  ) with check (
    business_id = (select public.current_business_id())
    and (select public.current_business_role()) in ('owner', 'manager')
    and exists (
      select 1 from public.users u
      where u.business_id = post_office_workspaces.business_id
        and lower(u.email) = 'jackie@thepostoffice.co.nz'
    )
  );

create policy post_office_delete on public.post_office_workspaces
  for delete to authenticated using (
    business_id = (select public.current_business_id())
    and (select public.current_business_role()) in ('owner', 'manager')
    and exists (
      select 1 from public.users u
      where u.business_id = post_office_workspaces.business_id
        and lower(u.email) = 'jackie@thepostoffice.co.nz'
    )
  );

-- Clients update revision = old + 1 WHERE revision = old. A stale conditional
-- update returns zero rows; an unconditional stale update fails this trigger.
create function public.post_office_workspace_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.revision <> 0 then
      raise exception 'Initial workspace revision must be zero' using errcode = '23514';
    end if;
  else
    if new.business_id is distinct from old.business_id then
      raise exception 'Workspace business cannot change' using errcode = '23514';
    end if;
    if new.revision <> old.revision + 1 then
      raise exception 'Workspace revision must increment by one' using errcode = '23514';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.post_office_workspace_revision() from public, anon, authenticated;
create trigger post_office_workspace_revision
  before insert or update on public.post_office_workspaces
  for each row execute function public.post_office_workspace_revision();
