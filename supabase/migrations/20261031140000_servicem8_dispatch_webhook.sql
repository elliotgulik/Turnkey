-- Let the durable ServiceM8 webhook worker upsert or remove one dispatch
-- activity at a time. Bulk range sync remains atomic in its own RPC.
create or replace function public.sync_servicem8_dispatch_event(
  p_business_id text,
  p_external_id text,
  p_event jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_business_id is null or nullif(p_external_id, '') is null or length(p_external_id) > 200 then
    raise exception 'Invalid ServiceM8 dispatch event key' using errcode = '22023';
  end if;
  if p_event is null then
    delete from public.calendar_events
    where business_id = p_business_id and source = 'servicem8' and external_id = p_external_id;
    return;
  end if;
  v_start := nullif(p_event->>'start_time', '')::timestamptz;
  v_end := nullif(p_event->>'end_time', '')::timestamptz;
  if v_start is null or v_end is null or v_end <= v_start or v_end - v_start > interval '24 hours'
     or nullif(trim(p_event->>'title'), '') is null or length(p_event->>'title') > 200 then
    raise exception 'Invalid ServiceM8 dispatch event' using errcode = '22023';
  end if;
  insert into public.calendar_events
    (business_id, user_id, connection_id, external_id, title, start_time, end_time, busy_status, source, notes)
  values (p_business_id, null, null, p_external_id, p_event->>'title', v_start, v_end, 'busy', 'servicem8', left(p_event->>'notes', 2000))
  on conflict (business_id, external_id) where source = 'servicem8' and external_id is not null
  do update set title = excluded.title, start_time = excluded.start_time,
    end_time = excluded.end_time, notes = excluded.notes, busy_status = 'busy';
end;
$$;

revoke all on function public.sync_servicem8_dispatch_event(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_servicem8_dispatch_event(text, text, jsonb)
  to service_role;
