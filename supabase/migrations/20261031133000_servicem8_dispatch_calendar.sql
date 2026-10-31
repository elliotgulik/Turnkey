-- Mirror ServiceM8 dispatch bookings into TurnKey's existing read-only
-- calendar event stream. No job/customer rows are created or rewritten.
alter table public.calendar_events
  drop constraint if exists calendar_events_source_check;
alter table public.calendar_events
  add constraint calendar_events_source_check
  check (source in ('external', 'turnkey', 'servicem8'));
alter table public.calendar_events alter column user_id drop not null;

create unique index if not exists calendar_events_servicem8_external_idx
  on public.calendar_events (business_id, external_id)
  where source = 'servicem8' and external_id is not null;

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
     busy_status, source, notes)
  select p_business_id, null, null, e.external_id, e.title, e.start_time, e.end_time,
         'busy', 'servicem8', e.notes
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as e(
    external_id text, title text, start_time timestamptz, end_time timestamptz, notes text
  )
  where nullif(e.external_id, '') is not null
    and e.title is not null and e.start_time is not null and e.end_time > e.start_time
    and e.start_time < p_to and e.end_time > p_from
  on conflict (business_id, external_id) where source = 'servicem8' and external_id is not null
  do update set title = excluded.title, start_time = excluded.start_time,
    end_time = excluded.end_time, notes = excluded.notes, busy_status = 'busy';

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
