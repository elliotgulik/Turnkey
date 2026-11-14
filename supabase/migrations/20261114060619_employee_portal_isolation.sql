-- Prepared locally only. Audited existing pg_policies/grants read-only on
-- 2026-11-14: legacy tenant-wide policies permit raw CRM/commercial reads.
-- Restrictive policies compose with those policies; they do not widen any
-- owner/manager tenant boundary or alter signed public RPCs / Post Office.
begin;

-- An event alone is not assignment authority. The current-generation job
-- mapping must corroborate the exact activity, job, employee and interval.
-- Events without that canonical booking snapshot intentionally fail closed.
create or replace function turnkey_private.post_job_time(value text)
returns timestamptz language plpgsql stable security invoker set search_path='' as $$
begin return value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;
revoke all on function turnkey_private.post_job_time(text) from public,anon,authenticated;
grant execute on function turnkey_private.post_job_time(text) to service_role;

create or replace function turnkey_private.post_job_dispatch(p_job public.jobs,p_employee uuid)
returns table(event_id uuid,start_time timestamptz,end_time timestamptz,work_date date,staff_ids jsonb)
language sql stable security invoker set search_path='' as $$
  select e.id,e.start_time,e.end_time,
    (e.start_time at time zone coalesce((select name from pg_catalog.pg_timezone_names
      where name=m.snapshot#>>'{booking,timeZone}' limit 1),'UTC'))::date,
    e.details->'assignedStaffIds'
  from public.servicem8_connections c
  join public.external_object_mappings m on m.business_id=c.business_id and m.connection_generation=c.generation
    and m.object_type='job' and m.local_id=p_job.id::text
  join public.external_object_mappings i on i.business_id=c.business_id and i.connection_generation=c.generation
    and i.object_type='staff_identity' and i.local_id=p_employee::text
  join public.calendar_events e on e.business_id=c.business_id and e.source='servicem8'
    and e.external_id=m.snapshot#>>'{booking,activityUuid}'
    and e.details->>'jobUuid'=m.external_uuid
  where c.business_id=p_job.business_id and m.snapshot#>>'{booking,jobUuid}'=m.external_uuid
    and m.snapshot->>'status' in ('Work Order','Completed')
    and m.snapshot#>>'{booking,source}'='servicem8'
    and e.start_time=turnkey_private.post_job_time(m.snapshot#>>'{booking,startAt}')
    and e.end_time=turnkey_private.post_job_time(m.snapshot#>>'{booking,endAt}')
    and e.end_time>e.start_time
    and coalesce(m.snapshot#>'{booking,assignedStaffIds}','[]'::jsonb) @> jsonb_build_array('servicem8:'||i.external_uuid)
    and coalesce(e.details->'assignedStaffIds','[]'::jsonb) @> jsonb_build_array('servicem8:'||i.external_uuid);
$$;
revoke all on function turnkey_private.post_job_dispatch(public.jobs,uuid) from public,anon,authenticated;
grant execute on function turnkey_private.post_job_dispatch(public.jobs,uuid) to service_role;

create or replace function turnkey_private.post_job_assigned(p_job public.jobs,p_employee uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select p_job.assigned_to=p_employee
    or coalesce(p_job.details->'assignedStaffIds','[]'::jsonb) @> jsonb_build_array(p_employee::text)
    or exists(select 1 from public.external_object_mappings i join public.servicem8_connections c
      on c.business_id=i.business_id and c.generation=i.connection_generation
      where i.business_id=p_job.business_id and i.object_type='staff_identity' and i.local_id=p_employee::text
        and coalesce(p_job.details->'assignedStaffIds','[]'::jsonb) @> jsonb_build_array('servicem8:'||i.external_uuid))
    or exists(select 1 from turnkey_private.post_job_dispatch(p_job,p_employee));
$$;
revoke all on function turnkey_private.post_job_assigned(public.jobs,uuid) from public,anon,authenticated;
grant execute on function turnkey_private.post_job_assigned(public.jobs,uuid) to service_role;

create or replace function public.job_work_dispatch_access(p_business_id text,p_job_id uuid,p_employee_id uuid)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
  if current_user<>'service_role' then raise exception 'Trusted backend required' using errcode='42501'; end if;
  return exists(select 1 from public.jobs j join public.users u on u.id=p_employee_id and u.business_id=j.business_id
    where j.id=p_job_id and j.business_id=p_business_id and u.role in ('owner','manager','technician')
      and exists(select 1 from turnkey_private.post_job_dispatch(j,u.id)));
end;
$$;
revoke all on function public.job_work_dispatch_access(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.job_work_dispatch_access(text,uuid,uuid) to service_role;

create or replace function public.job_work_portal(
  p_business_id text,p_employee_id uuid,p_from date,p_to date
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare u public.users; identity jsonb; job_rows jsonb; branding jsonb;
begin
  if current_user <> 'service_role' then raise exception 'Trusted backend required' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>93 then
    raise exception 'Choose a forward range of at most 93 days' using errcode='22023';
  end if;
  select * into u from public.users where id=p_employee_id and business_id=p_business_id;
  if not found or u.role is null or u.role not in ('owner','manager','technician') then
    raise exception 'Staff member not found for this business' using errcode='42501';
  end if;
  select jsonb_build_object('id',u.id,'name',public.post_job_employee_name(p_business_id,u.id),
    'aliases',jsonb_build_array(u.id::text)||coalesce(jsonb_agg('servicem8:'||m.external_uuid) filter(where m.external_uuid is not null),'[]'::jsonb))
  into identity from public.external_object_mappings m
  join public.servicem8_connections c on c.business_id=m.business_id and c.generation=m.connection_generation
  where m.business_id=p_business_id and m.object_type='staff_identity' and m.local_id=u.id::text;
  select jsonb_build_object('id',id,'name',coalesce(name,''),'logoUrl',coalesce(logo_url,'')) into branding
    from public.businesses where id=p_business_id;

  select coalesce(jsonb_agg(out_job order by day_key,job_id),'[]'::jsonb) into job_rows from (
    select j.id job_id,coalesce(dispatch.work_date::text,j.scheduled_date::text,left(j.details->>'calendarStartAt',10)) day_key,
      jsonb_build_object('id',j.id,'status',j.status,'scheduled_date',coalesce(dispatch.work_date,j.scheduled_date),
        'customer',jsonb_build_object('name',coalesce(c.name,''),'email',coalesce(c.email,''),'phone',coalesce(c.phone,''),
          'address',coalesce(c.address,''),'suburb',coalesce(c.suburb,'')),
        'details',jsonb_build_object(
          'calendarStartAt',coalesce(to_jsonb(dispatch.start_time),to_jsonb(left(j.details->>'calendarStartAt',100))),'calendarEndAt',coalesce(to_jsonb(dispatch.end_time),to_jsonb(left(j.details->>'calendarEndAt',100))),
          'jobStatus',left(j.details->>'jobStatus',40),'postJobCompletedAt',left(j.details->>'postJobCompletedAt',100),
          'workerInstructions',case when jsonb_typeof(j.details->'workerInstructions')='string' then left(j.details->>'workerInstructions',4000) else '' end,
          'assignedStaffIds',coalesce((select jsonb_agg(v) from jsonb_array_elements(
            case when jsonb_typeof(coalesce(nullif(j.details->'assignedStaffIds','[]'::jsonb),dispatch.staff_ids))='array' then coalesce(nullif(j.details->'assignedStaffIds','[]'::jsonb),dispatch.staff_ids) else '[]'::jsonb end) v
            where jsonb_typeof(v)='string' and (v#>>'{}') ~* '^(servicem8:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),'[]'::jsonb)),
        'services',coalesce((select jsonb_agg(service_name order by ord) from (
          select left(btrim(case when jsonb_typeof(v)='string' then v#>>'{}'
            when jsonb_typeof(v)='object' then coalesce(v->>'label',v->>'name',v->>'svc') end),200) service_name,ord
          from jsonb_array_elements(case when jsonb_typeof(j.details->'services')='array' then j.details->'services' else '[]'::jsonb end)
            with ordinality as s(v,ord) where ord<=40
        ) services where nullif(service_name,'') is not null),'[]'::jsonb),
        'crew',coalesce((select jsonb_agg(display_name order by display_name) from (
          select distinct display_name from (
            select public.post_job_employee_name(p_business_id,staff.id) display_name
              from public.users staff where staff.business_id=p_business_id and
                (staff.id=j.assigned_to or coalesce(coalesce(nullif(j.details->'assignedStaffIds','[]'::jsonb),dispatch.staff_ids),'[]'::jsonb) @> jsonb_build_array(staff.id::text))
            union
            select left(btrim(m.snapshot->>'name'),160) from public.external_object_mappings m
              join public.servicem8_connections conn on conn.business_id=m.business_id and conn.generation=m.connection_generation
              where m.business_id=p_business_id and m.object_type='staff'
                and coalesce(coalesce(nullif(j.details->'assignedStaffIds','[]'::jsonb),dispatch.staff_ids),'[]'::jsonb) @> jsonb_build_array('servicem8:'||m.external_uuid)
          ) names where nullif(display_name,'') is not null and position('@' in display_name)=0
        ) safe_names),'[]'::jsonb)) out_job
    from public.jobs j left join lateral (select * from turnkey_private.post_job_dispatch(j,u.id) order by start_time,event_id limit 1) dispatch on true left join public.customers c on c.id=j.customer_id and c.business_id=p_business_id
    where j.business_id=p_business_id and coalesce(turnkey_private.post_job_assigned(j,u.id),false)
      and j.status<>'cancelled'
      and coalesce(dispatch.work_date::text,j.scheduled_date::text,left(j.details->>'calendarStartAt',10))>=p_from::text
      and coalesce(dispatch.work_date::text,j.scheduled_date::text,left(j.details->>'calendarStartAt',10))<p_to::text
  ) safe_jobs;
  return jsonb_build_object('employee',identity,'business',branding,'jobs',job_rows);
end;
$$;
revoke all on function public.job_work_portal(text,uuid,date,date) from public,anon,authenticated;
grant execute on function public.job_work_portal(text,uuid,date,date) to service_role;

-- The existing private role helper is SECURITY DEFINER and resolves auth.uid()
-- against users without re-entering users RLS. Never use JWT user_metadata.
do $isolate$
declare t text;
begin
  for t in select tablename from pg_catalog.pg_tables where schemaname='public'
    and tablename not in ('users','post_office_workspaces') loop
    if to_regclass(format('public.%I',t)) is null then continue; end if;
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists employee_portal_private on public.%I',t);
    execute format('create policy employee_portal_private on public.%I as restrictive for all to authenticated using (coalesce((select turnkey_private.current_business_role()) in (''owner'',''manager''),false)) with check (coalesce((select turnkey_private.current_business_role()) in (''owner'',''manager''),false))',t);
  end loop;
end;
$isolate$;

-- Preserve self-profile/MFA bootstrap and self-edit policies. Other staff
-- profiles remain available only to owners/managers inside their tenant.
drop policy if exists employee_portal_profile on public.users;
create policy employee_portal_profile on public.users as restrictive for select to authenticated
using (id=(select auth.uid()) or
  (business_id=(select turnkey_private.current_business_id()) and
    coalesce((select turnkey_private.current_business_role()) in ('owner','manager'),false)));

-- Both status views already use security_invoker=true in production. Pin
-- that property here so a restored legacy view cannot bypass the base RLS.
do $views$
declare v text;
begin
  foreach v in array array['email_accounts_status','calendar_connections_status'] loop
    if to_regclass('public.'||v) is not null then execute format('alter view public.%I set (security_invoker=true)',v); end if;
  end loop;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists employee_portal_uploads on storage.objects';
    execute 'create policy employee_portal_uploads on storage.objects as restrictive for all to authenticated using (coalesce((select turnkey_private.current_business_role()) in (''owner'',''manager''),false)) with check (coalesce((select turnkey_private.current_business_role()) in (''owner'',''manager''),false))';
  end if;
end;
$views$;
commit;
