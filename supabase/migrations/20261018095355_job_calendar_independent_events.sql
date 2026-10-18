-- Additive calendar workflows. Reuses existing tables and the booking lock.
-- Apply after 20261018094524; safe to rerun. No existing rows are changed.
-- Native mutations must use the backend RPCs so direct REST writes cannot
-- bypass ownership checks or race the shared conflict checks.
revoke insert, update, delete on public.calendar_events, public.availability_blocks from public, anon, authenticated;

alter table public.calendar_events enable row level security;
alter table public.availability_blocks enable row level security;
drop policy if exists "calendar scoped read" on public.calendar_events;
create policy "calendar scoped read" on public.calendar_events as restrictive for select to authenticated
 using (business_id=public.current_business_id() and
   (public.current_business_role() in ('owner','manager') or user_id=auth.uid()));
drop policy if exists "calendar scoped read" on public.availability_blocks;
create policy "calendar scoped read" on public.availability_blocks as restrictive for select to authenticated
 using (business_id=public.current_business_id() and
   (public.current_business_role() in ('owner','manager') or user_id=auth.uid() or user_id is null));

create or replace function public.job_calendar_upsert_event(
 p_business_id text, p_caller_id uuid, p_id uuid, p_staff_id uuid,
 p_title text, p_start_at timestamptz, p_end_at timestamptz,
 p_busy_status text, p_notes text, p_timezone text
) returns public.calendar_events language plpgsql security invoker set search_path = public as $$
declare
 v_role text; v_existing public.calendar_events; v_row public.calendar_events; v_window tstzrange;
begin
 select role into v_role from users where id=p_caller_id and business_id=p_business_id;
 if v_role is null then raise exception 'Caller not found for this business' using errcode='42501'; end if;
 if p_id is null or p_staff_id is null or nullif(trim(p_title),'') is null or length(p_title)>200
   or p_start_at is null or p_end_at is null or not isfinite(p_start_at) or not isfinite(p_end_at)
   or p_end_at<=p_start_at or p_end_at-p_start_at>interval '366 days'
   or p_busy_status is null or p_busy_status not in ('busy','free')
   or p_timezone is null or not exists(select 1 from pg_timezone_names where name=p_timezone)
 then raise exception 'Invalid event fields or time window' using errcode='22023'; end if;
 if v_role not in ('owner','manager') and p_staff_id<>p_caller_id then
   raise exception 'You can only manage your own events' using errcode='42501'; end if;
 if not exists(select 1 from users where id=p_staff_id and business_id=p_business_id) then
   raise exception 'Staff member not found for this business' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id,0));
 select * into v_existing from calendar_events where id=p_id for update;
 if v_existing.id is not null then
   if v_existing.business_id<>p_business_id then raise exception 'Event not found' using errcode='22023'; end if;
   if v_existing.source<>'turnkey' or v_existing.connection_id is not null or v_existing.external_id is not null then
     raise exception 'External calendar events are read-only' using errcode='42501'; end if;
   if v_role not in ('owner','manager') and v_existing.user_id<>p_caller_id then
     raise exception 'You can only manage your own events' using errcode='42501'; end if;
 end if;
 v_window:=tstzrange(p_start_at,p_end_at,'[)');
 if p_busy_status='busy' then
   if exists(select 1 from jobs j where j.business_id=p_business_id and j.status<>'cancelled'
     and (j.assigned_to=p_staff_id or j.details->'assignedStaffIds' ? p_staff_id::text)
     and job_calendar_job_interval(j,p_timezone) && v_window)
   or exists(select 1 from availability_blocks b where b.business_id=p_business_id
     and (b.user_id=p_staff_id or b.user_id is null) and tstzrange(b.start_at,b.end_at,'[)') && v_window)
   or exists(select 1 from calendar_events e where e.business_id=p_business_id and e.user_id=p_staff_id
     and e.id<>p_id and e.busy_status='busy' and tstzrange(e.start_time,e.end_time,'[)') && v_window)
   then raise exception 'Scheduling conflict: staff member is busy or unavailable' using errcode='23P01'; end if;
 end if;
 insert into calendar_events(id,business_id,user_id,title,start_time,end_time,busy_status,notes,source,created_by)
 values(p_id,p_business_id,p_staff_id,trim(p_title),p_start_at,p_end_at,p_busy_status,p_notes,'turnkey',p_caller_id)
 on conflict(id) do update set user_id=excluded.user_id,title=excluded.title,start_time=excluded.start_time,
   end_time=excluded.end_time,busy_status=excluded.busy_status,notes=excluded.notes
 where calendar_events.business_id=p_business_id and calendar_events.source='turnkey'
   and calendar_events.connection_id is null and calendar_events.external_id is null
 returning * into v_row;
 if v_row.id is null then raise exception 'Event not found' using errcode='22023'; end if;
 return v_row;
end $$;
revoke all on function public.job_calendar_upsert_event(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.job_calendar_upsert_event(text,uuid,uuid,uuid,text,timestamptz,timestamptz,text,text,text) to service_role;

-- Delete performs ownership checks under the SAME lock as upsert/booking.
create or replace function public.job_calendar_delete_item(p_business_id text,p_caller_id uuid,p_id uuid,p_kind text)
returns void language plpgsql security invoker set search_path=public as $$
declare v_role text; v_user uuid; v_event public.calendar_events;
begin
 select role into v_role from users where id=p_caller_id and business_id=p_business_id;
 if v_role is null then raise exception 'Caller not found for this business' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id,0));
 if p_kind='event' then
   select * into v_event from calendar_events where id=p_id and business_id=p_business_id for update;
   if not found then raise exception 'Event not found' using errcode='22023'; end if;
   if v_event.source<>'turnkey' or v_event.connection_id is not null or v_event.external_id is not null then
     raise exception 'External calendar events are read-only' using errcode='42501'; end if;
   v_user:=v_event.user_id;
 elsif p_kind='block' then
   select user_id into v_user from availability_blocks where id=p_id and business_id=p_business_id for update;
   if not found then raise exception 'Block not found' using errcode='22023'; end if;
 else raise exception 'Invalid calendar item type' using errcode='22023'; end if;
 if v_role not in ('owner','manager') and (v_user is null or v_user<>p_caller_id) then
   raise exception 'You can only remove your own calendar items' using errcode='42501'; end if;
 if p_kind='event' then delete from calendar_events where id=p_id and business_id=p_business_id;
 else delete from availability_blocks where id=p_id and business_id=p_business_id; end if;
end $$;
revoke all on function public.job_calendar_delete_item(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.job_calendar_delete_item(text,uuid,uuid,text) to service_role;

-- Google is deliberately detached locally, never deleted remotely. Keep the
-- event ID/owner as a reference (and for an explicit later re-sync). No
-- imported calendar_events row is modified, and assignment/sales data stays.
create or replace function public.job_calendar_unschedule(p_business_id text,p_caller_id uuid,p_job_id uuid)
returns public.jobs language plpgsql security invoker set search_path=public as $$
declare v_role text; v_job public.jobs;
begin
 select role into v_role from users where id=p_caller_id and business_id=p_business_id;
 if v_role is null or v_role not in ('owner','manager') then
   raise exception 'Only an owner or manager can manage bookings' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id,0));
 select * into v_job from jobs where id=p_job_id and business_id=p_business_id for update;
 if not found then raise exception 'Job not found' using errcode='22023'; end if;
 if v_job.status in ('completed','paid') then raise exception 'Completed/paid bookings cannot be unscheduled here' using errcode='22023'; end if;
 update jobs set scheduled_date=null,
   details=(coalesce(details,'{}'::jsonb)-array['calendarStartAt','calendarEndAt','scheduledStartMin','scheduledDurationMin','calendarGoogleSyncedAt','calendarGoogleSyncError'])
     || jsonb_build_object('calendarGoogleSync',false,'calendarGoogleSyncState','detached')
 where id=p_job_id and business_id=p_business_id returning * into v_job;
 return v_job;
end $$;
revoke all on function public.job_calendar_unschedule(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.job_calendar_unschedule(text,uuid,uuid) to service_role;

-- A Google response arriving after unschedule must not restore sync intent.
-- Keep the original signature and JSON merge behavior for booked jobs.
create or replace function public.job_calendar_set_google_status(p_business_id text,p_job_id uuid,p_patch jsonb)
returns public.jobs language plpgsql security invoker set search_path=public as $$
declare v_job public.jobs;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_business_id,0));
 select * into v_job from jobs where id=p_job_id and business_id=p_business_id for update;
 if not found then raise exception 'Job not found for this business' using errcode='22023'; end if;
 if v_job.scheduled_date is null or not (v_job.details ? 'calendarStartAt') then return v_job; end if;
 update jobs set details=coalesce(details,'{}'::jsonb)||coalesce(p_patch,'{}'::jsonb)
 where id=p_job_id and business_id=p_business_id returning * into v_job;
 return v_job;
end $$;
revoke all on function public.job_calendar_set_google_status(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.job_calendar_set_google_status(text,uuid,jsonb) to service_role;
