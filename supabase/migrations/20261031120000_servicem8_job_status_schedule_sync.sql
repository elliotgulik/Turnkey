-- Atomically apply the latest ServiceM8 state to its linked TurnKey job.
-- The function is backend-only; the service-role worker calls it after a
-- durable, deduplicated ServiceM8 webhook has been processed.
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
begin
  update public.jobs
  set details = (coalesce(details, '{}'::jsonb) - 'serviceM8Booking') ||
      jsonb_strip_nulls(jsonb_build_object(
        'serviceM8Status', left(p_status, 100),
        'serviceM8Booking', p_booking
      )),
      scheduled_date = case
        when p_booking is null then null
        else (p_booking->>'startAt')::timestamptz::date
      end,
      status = case
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
