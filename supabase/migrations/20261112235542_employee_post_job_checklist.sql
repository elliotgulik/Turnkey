-- Backend-only writes. No changes to the independent Post Office workflow.
begin;
alter table public.businesses add column if not exists post_job_settings jsonb not null default '{"enabled":true,"reviewUrl":""}'::jsonb;
update public.businesses
set post_job_settings = coalesce(post_job_settings, '{}'::jsonb) || jsonb_build_object('reviewUrl','https://g.page/r/CbDFAxFaaWMUEBM/review')
where id = '041e386f-beeb-4dd8-a515-e4293629a921'
  and nullif(btrim(post_job_settings->>'reviewUrl'),'') is null;

create schema if not exists turnkey_private;
create table if not exists public.post_job_checklists (
  business_id text not null references public.businesses(id),
  job_id uuid not null references public.jobs(id),
  employee_id uuid not null references public.users(id),
  employee_name text not null,
  responses jsonb not null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (job_id, employee_id)
);
alter table public.post_job_checklists enable row level security;
revoke all on public.post_job_checklists from public, anon, authenticated;
grant select on public.post_job_checklists to authenticated;
grant select, insert, update on public.post_job_checklists to service_role;
drop policy if exists post_job_read on public.post_job_checklists;
create policy post_job_read on public.post_job_checklists for select to authenticated
using (exists (select 1 from public.users u where u.id = (select auth.uid())
  and u.business_id = post_job_checklists.business_id
  and (u.id = post_job_checklists.employee_id or u.role in ('owner','manager'))));

create or replace function turnkey_private.post_job_assigned(p_job public.jobs, p_employee uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select p_job.assigned_to = p_employee
    or coalesce(p_job.details->'assignedStaffIds','[]'::jsonb) @> jsonb_build_array(p_employee::text)
    or exists (
      select 1 from public.external_object_mappings m
      join public.servicem8_connections c on c.business_id=m.business_id and c.generation=m.connection_generation
      where m.business_id=p_job.business_id and m.object_type='staff_identity' and m.local_id=p_employee::text
        and coalesce(p_job.details->'assignedStaffIds','[]'::jsonb) @> jsonb_build_array('servicem8:' || m.external_uuid)
    );
$$;
revoke all on function turnkey_private.post_job_assigned(public.jobs,uuid) from public,anon,authenticated;
grant usage on schema turnkey_private to service_role;
grant execute on function turnkey_private.post_job_assigned(public.jobs,uuid) to service_role;

-- Canonical allowlist and validation shared by drafts and completion. Review
-- scanning is always optional and never inferred from any other response.
create or replace function turnkey_private.post_job_responses(p jsonb, completing boolean)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare r jsonb; k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'responses must be an object' using errcode='22023';
  end if;
  if p ? 'customerHome' and p->'customerHome' <> 'null'::jsonb and jsonb_typeof(p->'customerHome') <> 'boolean' then
    raise exception 'customerHome must be null or boolean' using errcode='22023';
  end if;
  r := jsonb_build_object('customerHome',coalesce(p->'customerHome','null'::jsonb));
  foreach k in array array['qualityCheck','reviewScanned','askedUpcomingWork','askedFrequency','injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap'] loop
    if p ? k and jsonb_typeof(p->k) <> 'boolean' then
      raise exception '% must be a boolean', k using errcode='22023';
    end if;
    r := r || jsonb_build_object(k,coalesce(p->k,'false'::jsonb));
  end loop;
  foreach k in array array['upcomingWorkNotes','frequencyAnswer'] loop
    if p ? k and jsonb_typeof(p->k) <> 'string' then
      raise exception '% must be text', k using errcode='22023';
    end if;
    if length(coalesce(p->>k,'')) > (case when k='upcomingWorkNotes' then 2000 else 500 end) then
      raise exception '% is too long', k using errcode='22023';
    end if;
    r := r || jsonb_build_object(k,coalesce(p->>k,''));
  end loop;
  if r->'customerHome' = 'false'::jsonb then
    r := r || '{"qualityCheck":false,"reviewScanned":false,"askedUpcomingWork":false,"upcomingWorkNotes":"","askedFrequency":false,"frequencyAnswer":""}'::jsonb;
  end if;
  if completing then
    if r->'customerHome' = 'null'::jsonb then
      raise exception 'Answer whether the customer was home' using errcode='22023';
    end if;
    if r->'customerHome' = 'true'::jsonb and r->'qualityCheck' <> 'true'::jsonb then
      raise exception 'Confirm the quality check with the customer' using errcode='22023';
    end if;
    foreach k in array array['injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap'] loop
      if r->k <> 'true'::jsonb then
        raise exception 'Complete required check: %', k using errcode='22023';
      end if;
    end loop;
  end if;
  return r;
end;
$$;
revoke all on function turnkey_private.post_job_responses(jsonb,boolean) from public,anon,authenticated;
grant execute on function turnkey_private.post_job_responses(jsonb,boolean) to service_role;
alter table public.post_job_checklists drop constraint if exists post_job_valid_responses;
alter table public.post_job_checklists add constraint post_job_valid_responses check (
  responses = turnkey_private.post_job_responses(responses,completed_at is not null)
);

create or replace function turnkey_private.post_job_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.completed_at is not null then
    raise exception 'Completed checklists are immutable' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function turnkey_private.post_job_immutable() from public,anon,authenticated;
drop trigger if exists post_job_immutable on public.post_job_checklists;
create trigger post_job_immutable before update or delete on public.post_job_checklists
for each row execute function turnkey_private.post_job_immutable();

create or replace function turnkey_private.post_job_record(p public.post_job_checklists)
returns jsonb language sql immutable security invoker set search_path = '' as $$
select case when p.job_id is null then null else jsonb_build_object(
  'responses',p.responses,'employeeId',p.employee_id,'employeeName',p.employee_name,
  'jobId',p.job_id,'updatedAt',p.updated_at,'completedAt',p.completed_at) end;
$$;
revoke all on function turnkey_private.post_job_record(public.post_job_checklists) from public,anon,authenticated;
grant execute on function turnkey_private.post_job_record(public.post_job_checklists) to service_role;

-- Display matching never grants access. Explicit identity links outrank a
-- shared mailbox; email matching is permitted only when unique on both sides
-- and cannot borrow staff already confirmed as a different local employee.
create or replace function public.post_job_employee_name(p_business_id text,p_employee_id uuid)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare u public.users; display_name text; matches integer;
begin
  if current_user <> 'service_role' then raise exception 'Trusted backend required' using errcode='42501'; end if;
  select * into u from public.users where id=p_employee_id and business_id=p_business_id;
  if not found then raise exception 'Staff member not found for this business' using errcode='42501'; end if;
  select count(*),min(btrim(s.snapshot->>'name')) into matches,display_name
  from public.external_object_mappings i
  join public.servicem8_connections c on c.business_id=i.business_id and c.generation=i.connection_generation
  join public.external_object_mappings s on s.business_id=i.business_id and s.connection_generation=i.connection_generation
    and s.object_type='staff' and s.external_uuid=i.external_uuid
  where i.business_id=p_business_id and i.object_type='staff_identity' and i.local_id=u.id::text
    and nullif(btrim(s.snapshot->>'name'),'') is not null and position('@' in s.snapshot->>'name')=0;
  if matches=1 then return left(display_name,160); end if;
  if nullif(btrim(u.email),'') is not null and
    (select count(*) from public.users x where x.business_id=p_business_id and lower(btrim(x.email))=lower(btrim(u.email)))=1 then
    select count(*),min(btrim(s.snapshot->>'name')) into matches,display_name
    from public.external_object_mappings s
    join public.servicem8_connections c on c.business_id=s.business_id and c.generation=s.connection_generation
    where s.business_id=p_business_id and s.object_type='staff'
      and lower(btrim(s.snapshot->>'email'))=lower(btrim(u.email))
      and nullif(btrim(s.snapshot->>'name'),'') is not null and position('@' in s.snapshot->>'name')=0
      and not exists(select 1 from public.external_object_mappings i where i.business_id=s.business_id
        and i.connection_generation=s.connection_generation and i.object_type='staff_identity'
        and i.external_uuid=s.external_uuid and i.local_id<>u.id::text);
    if matches=1 then return left(display_name,160); end if;
  end if;
  return coalesce(case when position('@' in u.name)=0 then nullif(btrim(u.name),'') end,nullif(btrim(u.email),''),'Staff member');
end;
$$;
revoke all on function public.post_job_employee_name(text,uuid) from public,anon,authenticated;
grant execute on function public.post_job_employee_name(text,uuid) to service_role;

-- PostgREST entrypoint: invoker, revoked from end users; caller identity is
-- supplied exclusively by the authenticated backend. Lock serializes save,
-- complete and concurrent retries, keeping both audit and job atomic.
create or replace function public.post_job_checklist(
  p_business_id text, p_job_id uuid, p_employee_id uuid, p_action text, p_responses jsonb default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs; u public.users; c public.post_job_checklists;
  r jsonb; h jsonb; linked boolean; already boolean := false;
  stamp timestamptz := now(); completion_details jsonb;
begin
  if current_user <> 'service_role' then raise exception 'Trusted backend required' using errcode='42501'; end if;
  select * into u from public.users where id=p_employee_id and business_id=p_business_id for share;
  if not found then raise exception 'Staff member not found for this business' using errcode='42501'; end if;
  select * into j from public.jobs where id=p_job_id and business_id=p_business_id for update;
  if not found then raise exception 'Job not found' using errcode='P0002'; end if;
  if u.role is null or (u.role not in ('owner','manager') and (u.role <> 'technician' or not coalesce(turnkey_private.post_job_assigned(j,u.id),false))) then
    raise exception 'You must be assigned to this job' using errcode='42501';
  end if;
  if p_action is null or p_action not in ('get','save','complete') then raise exception 'Invalid checklist action' using errcode='22023'; end if;
  select * into c from public.post_job_checklists where job_id=j.id and employee_id=u.id and business_id=p_business_id;
  if p_action <> 'get' then
    if c.completed_at is not null then
      already := true;
    else
      if p_action='complete' and j.status not in ('won','scheduled','completed') then
        raise exception 'Only an accepted job can be completed' using errcode='23514';
      end if;
      r := turnkey_private.post_job_responses(p_responses,p_action='complete');
      insert into public.post_job_checklists(business_id,job_id,employee_id,employee_name,responses,updated_at,completed_at)
      values(p_business_id,j.id,u.id,public.post_job_employee_name(p_business_id,u.id),r,stamp,case when p_action='complete' then stamp end)
      on conflict(job_id,employee_id) do update set responses=excluded.responses,employee_name=excluded.employee_name,
        updated_at=excluded.updated_at,completed_at=excluded.completed_at
      returning * into c;
    end if;
  end if;
  if p_action='get' then
    select coalesce(jsonb_agg(turnkey_private.post_job_record(x) order by x.completed_at desc,x.employee_id),'[]'::jsonb)
    into h from public.post_job_checklists x where x.business_id=p_business_id and x.job_id=j.id and x.completed_at is not null
      and (u.role in ('owner','manager') or x.employee_id=u.id);
    return jsonb_build_object('checklist',turnkey_private.post_job_record(c),'history',h);
  end if;
  if p_action='save' then return jsonb_build_object('checklist',turnkey_private.post_job_record(c),'alreadyCompleted',already); end if;
  linked := nullif(j.details->>'serviceM8JobUuid','') is not null
    or nullif(j.details->>'serviceM8Status','') is not null
    or exists(select 1 from public.external_object_mappings m where m.business_id=p_business_id and m.object_type='job' and m.local_id=j.id::text);
  if not already then
    -- The first accepted completion owns the job's completion timestamps;
    -- other employees can still file their own immutable audit later.
    completion_details := jsonb_build_object('postJobCompletedAt',coalesce(j.details->>'postJobCompletedAt',c.completed_at::text));
    if not linked then
      completion_details := completion_details || jsonb_build_object('finishedAt',coalesce(j.details->>'finishedAt',c.completed_at::text),'jobStatus','completed');
    end if;
    update public.jobs set details=coalesce(details,'{}'::jsonb)||completion_details,
      status=case when linked then status else 'completed' end, updated_at=stamp
      where id=j.id and business_id=p_business_id returning * into j;
  end if;
  completion_details := jsonb_build_object('postJobCompletedAt',j.details->'postJobCompletedAt');
  if not linked then completion_details := completion_details || jsonb_build_object('finishedAt',j.details->'finishedAt','jobStatus',j.details->'jobStatus'); end if;
  return jsonb_build_object('checklist',turnkey_private.post_job_record(c),'alreadyCompleted',already,
    'statusManagedByServiceM8',linked,'job',jsonb_build_object('id',j.id,'status',j.status,'details',completion_details));
end;
$$;
revoke all on function public.post_job_checklist(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.post_job_checklist(text,uuid,uuid,text,jsonb) to service_role;

-- Runs AFTER the existing aaa_guard_servicem8_operational_state trigger.
-- Security definer is limited to trigger-only tenant/role lookups; it exposes
-- no callable write API and cannot be used to impersonate another employee.
create or replace function turnkey_private.guard_post_job_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare caller public.users; enabled boolean; k text; changed_completion boolean := false;
begin
  if current_setting('role',true) not in ('authenticated','anon') then return new; end if;
  select * into caller from public.users where id=auth.uid();
  if caller.role in ('owner','manager') and caller.business_id=new.business_id then return new; end if;
  select coalesce(post_job_settings->'enabled','true'::jsonb) <> 'false'::jsonb into enabled from public.businesses where id=new.business_id;
  if enabled is false then return new; end if;
  if tg_op='INSERT' then
    changed_completion := new.status='completed' or new.details->>'jobStatus'='completed'
      or new.details ?| array['postJobCompletedAt','finishedAt'];
  else
    if new.assigned_to is distinct from old.assigned_to
      or new.details->'assignedStaffIds' is distinct from old.details->'assignedStaffIds' then
      raise exception 'Only an owner or manager can change job assignment' using errcode='42501';
    end if;
    changed_completion := (new.status is distinct from old.status and (new.status='completed' or old.status='completed'))
      or (new.details->>'jobStatus' is distinct from old.details->>'jobStatus' and (new.details->>'jobStatus'='completed' or old.details->>'jobStatus'='completed'));
    foreach k in array array['postJobCompletedAt','finishedAt'] loop
      changed_completion := changed_completion or new.details->k is distinct from old.details->k;
    end loop;
  end if;
  -- End users complete through the atomic RPC, never through a generic jobs
  -- update. Even an existing audit cannot be used to forge a new lifecycle.
  if coalesce(changed_completion,false) then
    raise exception 'Complete the post-job checklist through the job-work endpoint' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function turnkey_private.guard_post_job_completion() from public,anon,authenticated;
drop trigger if exists z_guard_post_job_completion on public.jobs;
create trigger z_guard_post_job_completion before insert or update on public.jobs
for each row execute function turnkey_private.guard_post_job_completion();

-- Do not allow a worker to disable the guard through a generic business save.
create or replace function turnkey_private.guard_post_job_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role',true) in ('authenticated','anon') and new.post_job_settings is distinct from old.post_job_settings
    and not exists(select 1 from public.users where id=auth.uid() and business_id=old.id and role in ('owner','manager')) then
    raise exception 'Only an owner or manager can change checklist settings' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function turnkey_private.guard_post_job_settings() from public,anon,authenticated;
drop trigger if exists guard_post_job_settings on public.businesses;
create trigger guard_post_job_settings before update on public.businesses
for each row execute function turnkey_private.guard_post_job_settings();
commit;
