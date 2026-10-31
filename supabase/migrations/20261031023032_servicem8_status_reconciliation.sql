-- Keep the TurnKey sales stage aligned when ServiceM8 changes an already
-- linked job, while retaining the exact upstream status for display/audit.
-- Sales-only stages (including contacted) are never downgraded by this sync.
create or replace function public.sync_servicem8_job_state(
  p_business_id text,
  p_job_id uuid,
  p_status text,
  p_booking jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cancelled boolean := lower(trim(coalesce(p_status, ''))) in ('cancelled', 'canceled', 'unsuccessful');
begin
  update public.jobs
  set details = (coalesce(details, '{}'::jsonb) - 'serviceM8Booking' - 'serviceM8Cancelled') ||
      jsonb_strip_nulls(jsonb_build_object(
        'serviceM8Status', left(p_status, 100),
        'serviceM8Booking', p_booking,
        'serviceM8Cancelled', case when v_cancelled then true else null end,
        'serviceM8SyncedAt', now()
      )),
      scheduled_date = case
        when p_booking is null then null
        else (p_booking->>'startAt')::timestamptz::date
      end,
      status = case
        when v_cancelled and status in ('won', 'scheduled', 'completed') then 'cancelled'
        when p_status = 'Completed' and status in ('won', 'scheduled') then 'completed'
        when p_status = 'Work Order' and p_booking is null and status = 'scheduled' then 'won'
        when p_booking is not null and p_status = 'Work Order' and status in ('won', 'scheduled') then 'scheduled'
        when p_status = 'Work Order' and status in ('new', 'quoted', 'followup') then 'won'
        when p_status = 'Quote' and status = 'new' then 'quoted'
        else status
      end,
      updated_at = now()
  where id = p_job_id and business_id = p_business_id;

  if not found then
    raise exception 'Linked TurnKey job not found for this business' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.sync_servicem8_job_state(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_servicem8_job_state(text, uuid, text, jsonb) to service_role;
