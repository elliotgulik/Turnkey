-- Keep a compact, display-safe ServiceM8 snapshot on each mirrored dispatch
-- event so the calendar can show the booking without a second API request.
alter table public.calendar_events
  add column if not exists details jsonb not null default '{}'::jsonb;

create or replace function public.sync_servicem8_dispatch_calendar(
  p_business_id text,
  p_from timestamptz,
  p_to timestamptz,
  p_events jsonb
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if current_user <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_business_id is null or p_from is null or p_to is null or p_to <= p_from
     or p_to - p_from > interval '93 days' or jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid ServiceM8 dispatch sync input' using errcode = '22023';
  end if;

  insert into public.calendar_events
    (business_id, user_id, connection_id, external_id, title, start_time, end_time,
     busy_status, source, notes, details)
  select p_business_id, null, null, e.external_id, e.title, e.start_time, e.end_time,
         'busy', 'servicem8', e.notes, coalesce(e.details, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as e(
    external_id text, title text, start_time timestamptz, end_time timestamptz,
    notes text, details jsonb
  )
  where nullif(e.external_id, '') is not null
    and e.title is not null and e.start_time is not null and e.end_time > e.start_time
    and e.start_time < p_to and e.end_time > p_from
  on conflict (business_id, external_id) where source = 'servicem8' and external_id is not null
  do update set title = excluded.title, start_time = excluded.start_time,
    end_time = excluded.end_time, notes = excluded.notes, details = excluded.details, busy_status = 'busy';

  get diagnostics v_count = row_count;
  delete from public.calendar_events ce
  where ce.business_id = p_business_id and ce.source = 'servicem8'
    and ce.start_time < p_to and ce.end_time > p_from
    and not exists (
      select 1 from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as e(external_id text)
      where e.external_id = ce.external_id
    );
  return v_count;
end;
$$;

revoke all on function public.sync_servicem8_dispatch_calendar(text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_servicem8_dispatch_calendar(text, timestamptz, timestamptz, jsonb)
  to service_role;

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
    (business_id, user_id, connection_id, external_id, title, start_time, end_time,
     busy_status, source, notes, details)
  values (p_business_id, null, null, p_external_id, p_event->>'title', v_start, v_end,
    'busy', 'servicem8', left(p_event->>'notes', 2000), coalesce(p_event->'details', '{}'::jsonb))
  on conflict (business_id, external_id) where source = 'servicem8' and external_id is not null
  do update set title = excluded.title, start_time = excluded.start_time,
    end_time = excluded.end_time, notes = excluded.notes, details = excluded.details, busy_status = 'busy';
end;
$$;

revoke all on function public.sync_servicem8_dispatch_event(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_servicem8_dispatch_event(text, text, jsonb)
  to service_role;
