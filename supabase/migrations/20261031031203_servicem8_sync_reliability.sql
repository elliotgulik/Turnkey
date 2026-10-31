begin;
alter table public.integration_tasks drop constraint if exists integration_tasks_kind_check;
alter table public.integration_tasks add constraint integration_tasks_kind_check
  check (kind in ('handoff','webhook','refresh_job','reminder','dispatch_seed'));

-- Exact linked ServiceM8 statuses own the operational stage. Completing a
-- formerly quoted record must work too, and completion must retain history.
create or replace function public.sync_servicem8_job_state(
  p_business_id text, p_job_id uuid, p_status text, p_booking jsonb,
  p_schedule_permission_missing boolean
) returns void language plpgsql security invoker set search_path=public as $$
declare
  v_job public.jobs;
  v_details jsonb;
  v_status text;
  v_date date;
  v_cancelled boolean := lower(trim(coalesce(p_status,''))) in ('cancelled','canceled','unsuccessful');
begin
  select * into v_job from public.jobs where id=p_job_id and business_id=p_business_id for update;
  if not found then raise exception 'Linked TurnKey job not found for this business' using errcode='22023'; end if;
  v_details:=coalesce(v_job.details,'{}'::jsonb)-'serviceM8Cancelled';
  v_details:=v_details||jsonb_build_object('serviceM8Status',left(p_status,100));
  if v_cancelled then v_details:=v_details||jsonb_build_object('serviceM8Cancelled',true); end if;
  v_date:=v_job.scheduled_date;
  if not coalesce(p_schedule_permission_missing,false) and p_status='Work Order' then
    v_details:=v_details-'serviceM8Booking';
    if p_booking is not null then v_details:=v_details||jsonb_build_object('serviceM8Booking',p_booking); end if;
    v_date:=case when p_booking is not null then timezone(coalesce(nullif(p_booking->>'timeZone',''),'UTC'),(p_booking->>'startAt')::timestamptz)::date else null end;
  elsif p_booking is not null then
    v_details:=v_details||jsonb_build_object('serviceM8Booking',p_booking);
  end if;
  v_status:=case
    when v_job.status='paid' then 'paid'
    when p_status='Completed' then 'completed'
    when v_cancelled then 'cancelled'
    when p_status='Work Order' and (p_booking is not null or (coalesce(p_schedule_permission_missing,false) and v_job.status='scheduled')) then 'scheduled'
    when p_status='Work Order' then 'won'
    when p_status='Quote' and v_job.status='new' then 'quoted'
    else v_job.status end;
  if v_status is distinct from v_job.status or v_date is distinct from v_job.scheduled_date
    or v_details is distinct from coalesce(v_job.details,'{}'::jsonb) then
    update public.jobs set status=v_status,scheduled_date=v_date,
      details=v_details||jsonb_build_object('serviceM8SyncedAt',now()),updated_at=now()
    where id=p_job_id and business_id=p_business_id;
  end if;
end;
$$;
create or replace function public.sync_servicem8_job_state(
  p_business_id text,p_job_id uuid,p_status text,p_booking jsonb
) returns void language sql security invoker set search_path=public as $$
  select public.sync_servicem8_job_state(p_business_id,p_job_id,p_status,p_booking,false);
$$;
revoke all on function public.sync_servicem8_job_state(text,uuid,text,jsonb),
  public.sync_servicem8_job_state(text,uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.sync_servicem8_job_state(text,uuid,text,jsonb),
  public.sync_servicem8_job_state(text,uuid,text,jsonb,boolean) to service_role;

-- An older open browser must not overwrite a newer upstream completion or
-- cancellation while saving unrelated customer/quote notes.
create or replace function public.guard_servicem8_operational_state()
returns trigger language plpgsql security invoker set search_path=public as $$
declare k text;
begin
  if current_user in ('authenticated','anon') and
    coalesce(old.details->>'serviceM8Status','') in ('Work Order','Completed','Cancelled','Canceled','Unsuccessful') then
    new.status:=old.status;
    new.scheduled_date:=old.scheduled_date;
    new.details:=coalesce(new.details,'{}'::jsonb);
    foreach k in array array['serviceM8Status','serviceM8Booking','serviceM8Cancelled','serviceM8SyncedAt'] loop
      new.details:=new.details-k;
      if old.details ? k then new.details:=new.details||jsonb_build_object(k,old.details->k); end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_servicem8_operational_state() from public,anon,authenticated;
drop trigger if exists aaa_guard_servicem8_operational_state on public.jobs;
create trigger aaa_guard_servicem8_operational_state before update on public.jobs
  for each row execute function public.guard_servicem8_operational_state();
commit;
