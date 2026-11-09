-- Company-scoped production workspace for The Post Office.
-- The CLI was unavailable when preparing this migration.
create table if not exists public.post_office_workspaces (
  business_id text primary key references public.businesses(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.post_office_workspaces enable row level security;
revoke all on public.post_office_workspaces from public, anon, authenticated;
grant select, insert, update, delete on public.post_office_workspaces to authenticated;

-- Pinned company identity plus current authenticated membership, never email/JWT metadata.
drop policy if exists post_office_read on public.post_office_workspaces;
create policy post_office_read on public.post_office_workspaces
  for select to authenticated using (
    business_id = '83c8112c-ad39-468d-b384-de593767e291'
    and business_id = (select public.current_business_id())
    and exists (select 1 from public.users u where u.id = (select auth.uid())
      and u.business_id = post_office_workspaces.business_id)
  );

drop policy if exists post_office_insert on public.post_office_workspaces;
create policy post_office_insert on public.post_office_workspaces
  for insert to authenticated  with check (
    business_id = '83c8112c-ad39-468d-b384-de593767e291'
    and business_id = (select public.current_business_id())
    and exists (select 1 from public.users u where u.id = (select auth.uid())
      and u.business_id = post_office_workspaces.business_id)
    and (select public.current_business_role()) in ('owner', 'manager')
  );

drop policy if exists post_office_update on public.post_office_workspaces;
create policy post_office_update on public.post_office_workspaces
  for update to authenticated using (
    business_id = '83c8112c-ad39-468d-b384-de593767e291'
    and business_id = (select public.current_business_id())
    and exists (select 1 from public.users u where u.id = (select auth.uid())
      and u.business_id = post_office_workspaces.business_id)
    and (select public.current_business_role()) in ('owner', 'manager')
  ) with check (
    business_id = '83c8112c-ad39-468d-b384-de593767e291'
    and business_id = (select public.current_business_id())
    and exists (select 1 from public.users u where u.id = (select auth.uid())
      and u.business_id = post_office_workspaces.business_id)
    and (select public.current_business_role()) in ('owner', 'manager')
  );

drop policy if exists post_office_delete on public.post_office_workspaces;
create policy post_office_delete on public.post_office_workspaces
  for delete to authenticated using (
    business_id = '83c8112c-ad39-468d-b384-de593767e291'
    and business_id = (select public.current_business_id())
    and exists (select 1 from public.users u where u.id = (select auth.uid())
      and u.business_id = post_office_workspaces.business_id)
    and (select public.current_business_role()) in ('owner', 'manager')
  );

-- Clients update revision = old + 1 WHERE revision = old. A stale conditional
-- update returns zero rows; an unconditional stale update fails this trigger.
create or replace function public.post_office_workspace_revision()
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
drop trigger if exists post_office_workspace_revision on public.post_office_workspaces;
create trigger post_office_workspace_revision
  before insert or update on public.post_office_workspaces
  for each row execute function public.post_office_workspace_revision();

-- Internal authorization is not exposed as a Data API endpoint. Public RPCs
-- run as their owner solely to permit these narrow writes for staff under RLS.
create schema if not exists post_office_private;
revoke all on schema post_office_private from public, anon, authenticated;
create or replace function post_office_private.member_role()
returns text language plpgsql security invoker set search_path = '' as $$
declare member_role text;
begin
  select u.role into member_role from public.users u
    where u.id = auth.uid() and u.business_id = '83c8112c-ad39-468d-b384-de593767e291';
  if auth.uid() is null or member_role is null then
    raise exception 'Post Office company membership required' using errcode = '42501';
  end if;
  return member_role;
end;
$$;
revoke all on function post_office_private.member_role() from public, anon, authenticated;

-- entry: id (UUID), crewId, projectId, date (YYYY-MM-DD), start/end (HH:mm),
-- breakMinutes/travelMinutes (optional numbers, default 0), notes (optional).
-- Break is excluded from hours; break and travel are excluded from productiveHours.
create or replace function public.post_office_log_hours(entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller_role text := post_office_private.member_role();
  workspace public.post_office_workspaces;
  crew jsonb; old_entry jsonb; old_crew jsonb; clean_entry jsonb; logs jsonb;
  entry_id text; mapped_user text; minutes numeric; break_minutes numeric; travel_minutes numeric;
begin
  if jsonb_typeof(entry) is distinct from 'object' or
    coalesce(entry->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Entry id must be a UUID' using errcode = '22023';
  end if;
  entry_id := (entry->>'id')::uuid::text;
  select * into workspace from public.post_office_workspaces
    where business_id = '83c8112c-ad39-468d-b384-de593767e291' for update;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select c into crew from jsonb_array_elements(coalesce(workspace.state->'crew', '[]')) c
    where c->>'id' = entry->>'crewId';
  if crew is null then raise exception 'Crew not found' using errcode = '22023'; end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(workspace.state->'projects', '[]')) p
    where p->>'id' = entry->>'projectId') then
    raise exception 'Project not found' using errcode = '22023';
  end if;
  mapped_user := nullif(crew->>'userId', '');
  if mapped_user is not null and not exists (select 1 from public.users u
    where u.id::text = mapped_user and u.business_id = workspace.business_id) then
    raise exception 'Crew user must belong to this company' using errcode = '42501';
  end if;
  select l into old_entry from jsonb_array_elements(coalesce(workspace.state->'workLogs', '[]')) l
    where lower(l->>'id') = entry_id;
  if caller_role not in ('owner', 'manager') then
    if mapped_user is distinct from auth.uid()::text then
      raise exception 'Staff may log only their mapped crew hours' using errcode = '42501';
    end if;
    if old_entry is not null then
      select c into old_crew from jsonb_array_elements(coalesce(workspace.state->'crew', '[]')) c
        where c->>'id' = old_entry->>'crewId';
      if old_crew->>'userId' is distinct from auth.uid()::text or old_entry->>'userId' is distinct from auth.uid()::text then
        raise exception 'Staff may update only their own existing hours' using errcode = '42501';
      end if;
    end if;
  end if;
  if coalesce(entry->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Date must be YYYY-MM-DD' using errcode = '22023';
  end if;
  perform (entry->>'date')::date; -- Reject impossible dates, not just malformed strings.
  if coalesce(entry->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or
    coalesce(entry->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Start and end must be HH:mm within one day' using errcode = '22023';
  end if;
  minutes := extract(epoch from ((entry->>'end')::time - (entry->>'start')::time)) / 60;
  if minutes <= 0 then raise exception 'End must be after start on the same day' using errcode = '22023'; end if;
  if (entry ? 'breakMinutes' and jsonb_typeof(entry->'breakMinutes') is distinct from 'number') or
    (entry ? 'travelMinutes' and jsonb_typeof(entry->'travelMinutes') is distinct from 'number') then
    raise exception 'Break and travel must be numbers' using errcode = '22023';
  end if;
  break_minutes := coalesce((entry->>'breakMinutes')::numeric, 0);
  travel_minutes := coalesce((entry->>'travelMinutes')::numeric, 0);
  if break_minutes < 0 or travel_minutes < 0 or break_minutes + travel_minutes > minutes then
    raise exception 'Break and travel must be nonnegative and fit within duration' using errcode = '22023';
  end if;
  clean_entry := jsonb_build_object('id', entry_id, 'crewId', crew->>'id', 'projectId', entry->>'projectId',
    'date', entry->>'date', 'start', entry->>'start', 'end', entry->>'end',
    'breakMinutes', break_minutes, 'travelMinutes', travel_minutes,
    'hours', round((minutes - break_minutes) / 60, 4),
    'productiveHours', round((minutes - break_minutes - travel_minutes) / 60, 4),
    'notes', coalesce(entry->>'notes', ''), 'userId', coalesce(mapped_user, auth.uid()::text),
    'submittedBy', auth.uid()::text);
  select coalesce(jsonb_agg(l order by n), '[]') into logs
    from jsonb_array_elements(coalesce(workspace.state->'workLogs', '[]')) with ordinality as x(l,n)
    where lower(l->>'id') is distinct from entry_id;
  update public.post_office_workspaces set
    state = jsonb_set(workspace.state, '{workLogs}', logs || jsonb_build_array(clean_entry)), revision = workspace.revision + 1
    where business_id = workspace.business_id returning * into workspace;
  return jsonb_build_object('state', workspace.state, 'revision', workspace.revision);
end;
$$;
revoke all on function public.post_office_log_hours(jsonb) from public, anon, authenticated;
grant execute on function public.post_office_log_hours(jsonb) to authenticated;

create or replace function public.post_office_remove_hours(entry_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller_role text := post_office_private.member_role();
  workspace public.post_office_workspaces; old_entry jsonb; crew jsonb; logs jsonb;
begin
  if entry_id is null or entry_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Entry id must be a UUID' using errcode = '22023';
  end if;
  entry_id := entry_id::uuid::text;
  select * into workspace from public.post_office_workspaces
    where business_id = '83c8112c-ad39-468d-b384-de593767e291' for update;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select l into old_entry from jsonb_array_elements(coalesce(workspace.state->'workLogs', '[]')) l
    where lower(l->>'id') = entry_id;
  if old_entry is null then raise exception 'Hours entry not found' using errcode = 'P0002'; end if;
  if caller_role not in ('owner', 'manager') then
    select c into crew from jsonb_array_elements(coalesce(workspace.state->'crew', '[]')) c
      where c->>'id' = old_entry->>'crewId';
    if crew->>'userId' is distinct from auth.uid()::text or old_entry->>'userId' is distinct from auth.uid()::text then
      raise exception 'Staff may remove only their own existing hours' using errcode = '42501';
    end if;
  end if;
  select coalesce(jsonb_agg(l order by n), '[]') into logs
    from jsonb_array_elements(workspace.state->'workLogs') with ordinality as x(l,n)
    where lower(l->>'id') is distinct from entry_id;
  update public.post_office_workspaces set state = jsonb_set(workspace.state, '{workLogs}', logs), revision = workspace.revision + 1
    where business_id = workspace.business_id returning * into workspace;
  return jsonb_build_object('state', workspace.state, 'revision', workspace.revision);
end;
$$;
revoke all on function public.post_office_remove_hours(text) from public, anon, authenticated;
grant execute on function public.post_office_remove_hours(text) to authenticated;

create or replace function public.post_office_toggle_task(project_id text, task_id text, done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller_role text := post_office_private.member_role();
  workspace public.post_office_workspaces; project_index integer; task_index integer;
begin
  if project_id is null or project_id = '' or task_id is null or task_id = '' or done is null then
    raise exception 'Project, task and done are required' using errcode = '22023';
  end if;
  select * into workspace from public.post_office_workspaces
    where business_id = '83c8112c-ad39-468d-b384-de593767e291' for update;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;
  select (n - 1)::integer into project_index
    from jsonb_array_elements(coalesce(workspace.state->'projects', '[]')) with ordinality as x(p,n)
    where p->>'id' = project_id;
  if project_index is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  select (n - 1)::integer into task_index
    from jsonb_array_elements(coalesce(workspace.state #> array['projects', project_index::text, 'checklist'], '[]')) with ordinality as x(t,n)
    where t->>'id' = task_id;
  if task_index is null then raise exception 'Checklist task not found' using errcode = 'P0002'; end if;
  update public.post_office_workspaces set state = jsonb_set(workspace.state,
    array['projects', project_index::text, 'checklist', task_index::text, 'done'], to_jsonb(done)), revision = workspace.revision + 1
    where business_id = workspace.business_id returning * into workspace;
  return jsonb_build_object('state', workspace.state, 'revision', workspace.revision);
end;
$$;
revoke all on function public.post_office_toggle_task(text, text, boolean) from public, anon, authenticated;
grant execute on function public.post_office_toggle_task(text, text, boolean) to authenticated;
