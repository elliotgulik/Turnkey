-- TurnKey — Job Calendar booking backend.
-- Source for a NEW migration file; the parent process applies this via the
-- official Supabase CLI-generated migration. Apply only this migration;
-- do not apply unrelated pending migrations as part of this release.
-- Every statement is idempotent — safe to run against a database that
-- already has some or all of this (re-running creates nothing twice and
-- destroys no existing data).
--
-- Reuses existing tables only — no new parallel pipelines/tables:
--   public.jobs                (id uuid, business_id text, customer_id uuid,
--                                assigned_to uuid, status text,
--                                scheduled_date date, details jsonb)
--                                                     — 20240101000000_... / schema-app.sql
--   public.customers           (id uuid, business_id text, name, address, suburb)
--                                                     — schema-app.sql
--   public.users               (id uuid, business_id text, role text check in
--                                ('owner','manager','technician'))
--                                                     — schema-app.sql / schema-team.sql
--   public.availability_blocks (id uuid, business_id text, user_id uuid|null,
--                                block_type, start_at, end_at, all_day, reason)
--                                                     — 20260810100000_...
--   public.calendar_events     (id uuid, business_id text, user_id uuid,
--                                connection_id uuid, external_id text, title,
--                                start_time, end_time, busy_status, source)
--                                                     — schema-calendar-and-checklists.sql
--                                                       / 20260810100000_...
--   public.calendar_connections(id uuid, business_id text, user_id uuid,
--                                provider text, sync_status, last_synced_at)
--                                                     — schema-calendar-and-checklists.sql
--
-- None of those tables are recreated, deleted or retyped here — only new,
-- private, service-role-only SQL functions are added, each `security
-- invoker` with a fixed `search_path` (never `security definer` — these
-- exist purely to make a multi-step, lock-protected write atomic from a
-- single backend round trip, never to escalate the caller's privileges;
-- the backend always calls them with the service-role key, which already
-- bypasses RLS, so a definer would add risk for zero benefit here).

-- ===== job_calendar_job_interval: derives a job's effective busy
-- [start,end) window for conflict checking. Prefers the authoritative
-- calendarStartAt/calendarEndAt pair written by job_calendar_book(); falls
-- back to deriving from scheduled_date + legacy scheduledStartMin/
-- scheduledDurationMin (in the given IANA timezone); and finally, for a
-- legacy job that only ever got a bare scheduled_date with no time-of-day
-- at all, conservatively treats the ENTIRE local day as busy — matching
-- how the old plain scheduled_date UI only ever let someone pick a day, not
-- a time, so there is no narrower window that's actually safe to assume. =====
create or replace function public.job_calendar_job_interval(p_job public.jobs, p_timezone text)
returns tstzrange
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tz text := coalesce(p_timezone, 'UTC');
  v_start timestamptz;
  v_end timestamptz;
  v_start_min int;
  v_duration_min int;
begin
  if p_job.details ? 'calendarStartAt' and p_job.details ? 'calendarEndAt' then
    begin
      v_start := (p_job.details->>'calendarStartAt')::timestamptz;
      v_end := (p_job.details->>'calendarEndAt')::timestamptz;
    exception when others then
      v_start := null; v_end := null;
    end;
    if v_start is not null and v_end is not null and v_end > v_start then
      return tstzrange(v_start, v_end, '[)');
    end if;
  end if;

  if p_job.scheduled_date is null then
    return null;
  end if;

  begin
    v_start_min := nullif(p_job.details->>'scheduledStartMin', '')::int;
    v_duration_min := nullif(p_job.details->>'scheduledDurationMin', '')::int;
  exception when others then
    v_start_min := null; v_duration_min := null;
  end;

  begin
    if v_start_min is not null and v_duration_min is not null and v_duration_min > 0 then
      v_start := (p_job.scheduled_date::timestamp + (v_start_min || ' minutes')::interval) at time zone v_tz;
      v_end := v_start + (v_duration_min || ' minutes')::interval;
    else
      -- No time-of-day on record at all — the whole local day is busy.
      v_start := p_job.scheduled_date::timestamp at time zone v_tz;
      v_end := v_start + interval '1 day';
    end if;
  exception when others then
    -- An invalid/unrecognised timezone falls back to treating this job as
    -- unscheduled for conflict purposes rather than raising into the
    -- caller's transaction — the caller's own timezone input is validated
    -- separately before this function is ever invoked for a NEW booking.
    return null;
  end;

  return tstzrange(v_start, v_end, '[)');
end;
$$;

revoke all on function public.job_calendar_job_interval(public.jobs, text) from public, anon, authenticated;
grant execute on function public.job_calendar_job_interval(public.jobs, text) to service_role;

-- ===== job_calendar_book: the one write path for booking/rescheduling a
-- job onto the calendar. Validates the caller's role and every assigned
-- staff member's tenancy again (never trusts the backend's own earlier
-- check alone), serializes against every other booking/block write for
-- this business with a single advisory lock, then checks for conflicts
-- against: other jobs assigned to any of the same staff, availability
-- blocks (per-staff or whole-business), and cached Google/native calendar
-- events — all as half-open ranges, so back-to-back bookings are allowed.
-- Raises a distinct errcode for conflicts (23P01) so the caller maps it to
-- HTTP 409, never a silent override of someone else's existing booking. =====
create or replace function public.job_calendar_book(
  p_business_id text,
  p_caller_id uuid,
  p_job_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text,
  p_staff_ids uuid[],
  p_team_label text,
  p_notes text,
  p_sync_google boolean,
  p_schedule_start_min int,
  p_schedule_duration_min int
) returns public.jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_caller_role text;
  v_job public.jobs;
  v_staff_id uuid;
  v_details jsonb;
  v_sync_google boolean;
  v_requested tstzrange := tstzrange(p_start_at, p_end_at, '[)');
begin
  if p_start_at is null or p_end_at is null then
    raise exception 'startAt/endAt are required' using errcode = '22023';
  end if;
  if p_end_at <= p_start_at or p_end_at - p_start_at > interval '24 hours' then
    raise exception 'Invalid booking window: end must be after start and within 24 hours' using errcode = '22023';
  end if;
  if p_staff_ids is null or array_length(p_staff_ids, 1) is null then
    raise exception 'At least one staff member must be assigned' using errcode = '22023';
  end if;

  select role into v_caller_role from public.users where id = p_caller_id and business_id = p_business_id;
  if v_caller_role is null then
    raise exception 'Caller not found for this business' using errcode = '22023';
  end if;
  if v_caller_role not in ('owner', 'manager') then
    raise exception 'Only an owner or manager can manage bookings' using errcode = '42501';
  end if;

  -- Serialize every booking/block write for this business — the exclusion
  -- checks below are the actual correctness guarantee, this lock just keeps
  -- two concurrent writers from both passing them for the same slot.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id, 0));

  select * into v_job from public.jobs where id = p_job_id and business_id = p_business_id for update;
  if v_job.id is null then
    raise exception 'Job not found for this business' using errcode = '22023';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'This job is lost/cancelled — change its stage before booking it' using errcode = '22023';
  end if;
  if v_job.status in ('completed', 'paid') then
    raise exception 'This job is already completed/paid and cannot be rescheduled here' using errcode = '22023';
  end if;

  foreach v_staff_id in array p_staff_ids loop
    if not exists (select 1 from public.users where id = v_staff_id and business_id = p_business_id) then
      raise exception 'Assigned staff member not found for this business' using errcode = '22023';
    end if;
  end loop;

  foreach v_staff_id in array p_staff_ids loop
    -- Other jobs assigned to this staff member (single assigned_to, or
    -- present in a multi-staff booking's assignedStaffIds) that overlap.
    perform 1 from public.jobs j
      where j.business_id = p_business_id and j.id <> p_job_id
        and j.status not in ('cancelled')
        and (j.assigned_to = v_staff_id or j.details -> 'assignedStaffIds' ? v_staff_id::text)
        and public.job_calendar_job_interval(j, p_timezone) && v_requested
      limit 1;
    if found then
      raise exception 'Scheduling conflict: a staff member already has a booked job during this time' using errcode = '23P01';
    end if;

    -- Availability blocks: this staff member's own, or a whole-business block.
    perform 1 from public.availability_blocks b
      where b.business_id = p_business_id
        and (b.user_id = v_staff_id or b.user_id is null)
        and tstzrange(b.start_at, b.end_at, '[)') && v_requested
      limit 1;
    if found then
      raise exception 'Scheduling conflict: a staff member is marked unavailable during this time' using errcode = '23P01';
    end if;

    -- Cached native/external calendar busy time — excluding THIS job's own
    -- previously-synced Google event (matched by external_id), so
    -- rescheduling a job that's already linked to Google doesn't conflict
    -- against its own stale cached copy. IS DISTINCT FROM (not plain `=`)
    -- is required here: a busy row with a null external_id (most native
    -- TurnKey events, and any synced event whose id simply isn't cached)
    -- must still conflict — a bare `=` against NULL is itself NULL, which
    -- would have silently dropped it from the WHERE clause entirely.
    perform 1 from public.calendar_events ce
      where ce.business_id = p_business_id and ce.user_id = v_staff_id and ce.busy_status = 'busy'
        and tstzrange(ce.start_time, ce.end_time, '[)') && v_requested
        and (v_job.details ->> 'googleEventId' is null or ce.external_id is distinct from v_job.details ->> 'googleEventId')
      limit 1;
    if found then
      raise exception 'Scheduling conflict: a staff member''s calendar is busy during this time' using errcode = '23P01';
    end if;
  end loop;

  -- Once sync intent has been turned on for a job, a later reschedule that
  -- doesn't re-send syncGoogle=true must NOT silently turn it back off —
  -- the frontend's own UI disables unchecking an already-linked booking,
  -- and the backend mirrors that rather than trusting a bare `false` to
  -- mean "stop syncing" (which would desync a still-linked Google event
  -- without the caller ever explicitly asking to unlink it).
  v_sync_google := coalesce(p_sync_google, false) or coalesce((v_job.details ->> 'calendarGoogleSync')::boolean, false);

  v_details := coalesce(v_job.details, '{}'::jsonb) || jsonb_build_object(
    'calendarStartAt', p_start_at,
    'calendarEndAt', p_end_at,
    'scheduledStartMin', p_schedule_start_min,
    'scheduledDurationMin', p_schedule_duration_min,
    'assignedStaffIds', to_jsonb(p_staff_ids),
    'calendarTeamLabel', p_team_label,
    'calendarNotes', p_notes,
    'calendarGoogleSync', v_sync_google,
    -- A reschedule invalidates any prior "synced" claim until the backend
    -- actually re-pushes the new time to Google — never leave a stale
    -- success status pointing at the OLD time. googleEventId itself is
    -- deliberately left untouched here (not part of this jsonb_build_object)
    -- so the stable-id PATCH-first path in the Google sync helper still has
    -- it to work with.
    'calendarGoogleSyncState', case when v_sync_google then 'pending' else null end,
    'calendarGoogleSyncError', null,
    'calendarGoogleSyncedAt', null
  );

  -- Deliberately NOT changing status here — booking/rescheduling a job onto
  -- the calendar must never disturb its sales stage (quoted/won/etc) or any
  -- timestamp/pricing that stage change carries elsewhere in the app (e.g.
  -- a sales-side trigger stamping wonAt the moment status becomes
  -- 'scheduled'). The calendar is purely a view onto when an already-sold
  -- job happens, not a second place that decides whether it's sold.

  update public.jobs set
    scheduled_date = (p_start_at at time zone coalesce(p_timezone, 'UTC'))::date,
    assigned_to = p_staff_ids[1],
    details = v_details
  where id = p_job_id and business_id = p_business_id
  returning * into v_job;

  return v_job;
end;
$$;

revoke all on function public.job_calendar_book(text, uuid, uuid, timestamptz, timestamptz, text, uuid[], text, text, boolean, int, int) from public, anon, authenticated;
grant execute on function public.job_calendar_book(text, uuid, uuid, timestamptz, timestamptz, text, uuid[], text, text, boolean, int, int) to service_role;

-- ===== job_calendar_upsert_block: owner/manager can block anyone or the
-- whole business; a technician can only block their own time. The same
-- client-provided id reused with the same content is a durable idempotent
-- retry (and a legitimate way to edit a block the caller already created).
-- A block is allowed to coexist with existing jobs — it does not silently
-- cancel or hide them — but the caller is told how many existing jobs now
-- fall inside the blocked window so the UI can warn, not silently absorb
-- the conflict. =====
create or replace function public.job_calendar_upsert_block(
  p_business_id text,
  p_caller_id uuid,
  p_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_all_day boolean,
  p_staff_id uuid,
  p_block_type text,
  p_reason text
) returns table(block public.availability_blocks, conflicting_jobs int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_caller_role text;
  v_existing public.availability_blocks;
  v_row public.availability_blocks;
  v_count int;
begin
  if p_id is null then
    raise exception 'A stable block id is required' using errcode = '22023';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'Invalid block window: end must be after start' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '366 days' then
    raise exception 'A block cannot span more than 366 days' using errcode = '22023';
  end if;

  select role into v_caller_role from public.users where id = p_caller_id and business_id = p_business_id;
  if v_caller_role is null then
    raise exception 'Caller not found for this business' using errcode = '22023';
  end if;

  if p_staff_id is null then
    if v_caller_role not in ('owner', 'manager') then
      raise exception 'Only an owner or manager can block the whole business' using errcode = '42501';
    end if;
  else
    if v_caller_role not in ('owner', 'manager') and p_staff_id <> p_caller_id then
      raise exception 'You can only block your own time' using errcode = '42501';
    end if;
    if not exists (select 1 from public.users where id = p_staff_id and business_id = p_business_id) then
      raise exception 'Staff member not found for this business' using errcode = '22023';
    end if;
  end if;

  -- Same per-business lock as job_calendar_book — blocks and bookings are
  -- the same conflict surface and must serialize against each other.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id, 0));

  select * into v_existing from public.availability_blocks where id = p_id;
  if v_existing.id is not null then
    if v_existing.business_id <> p_business_id then
      raise exception 'Block not found for this business' using errcode = '22023';
    end if;
    -- Reusing an id only edits a block the caller is already allowed to
    -- touch — checked against the EXISTING row's ownership, not just the
    -- new target. Without this, a technician could pass their own id as
    -- the new staff_id (which passes the "new target" check below on its
    -- own) and silently take over/overwrite someone else's — or a
    -- whole-business — block just by reusing its id.
    if v_caller_role not in ('owner', 'manager') and (v_existing.user_id is null or v_existing.user_id <> p_caller_id) then
      raise exception 'You can only edit your own block' using errcode = '42501';
    end if;
  end if;

  insert into public.availability_blocks (id, business_id, user_id, block_type, start_at, end_at, all_day, reason, created_by)
  values (p_id, p_business_id, p_staff_id, p_block_type, p_start_at, p_end_at, coalesce(p_all_day, false), p_reason, p_caller_id)
  on conflict (id) do update set
    user_id = excluded.user_id,
    block_type = excluded.block_type,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    all_day = excluded.all_day,
    reason = excluded.reason
  where public.availability_blocks.business_id = p_business_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Block not found for this business' using errcode = '22023';
  end if;

  select count(*)::int into v_count from public.jobs j
    where j.business_id = p_business_id and j.status <> 'cancelled'
      and (p_staff_id is null or j.assigned_to = p_staff_id or j.details -> 'assignedStaffIds' ? p_staff_id::text)
      and public.job_calendar_job_interval(j, 'UTC') && tstzrange(p_start_at, p_end_at, '[)');

  return query select v_row, v_count;
end;
$$;

revoke all on function public.job_calendar_upsert_block(text, uuid, uuid, timestamptz, timestamptz, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function public.job_calendar_upsert_block(text, uuid, uuid, timestamptz, timestamptz, boolean, uuid, text, text) to service_role;

-- ===== job_calendar_set_google_status: the only write path for recording
-- Google Calendar sync intent/result onto a job. Does a jsonb merge
-- (details = details || patch) in a single atomic UPDATE rather than a
-- REST read-modify-write from the backend, so a concurrent booking change
-- can never be clobbered by a stale full-details overwrite. =====
create or replace function public.job_calendar_set_google_status(
  p_business_id text,
  p_job_id uuid,
  p_patch jsonb
) returns public.jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_job public.jobs;
begin
  update public.jobs set details = coalesce(details, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)
  where id = p_job_id and business_id = p_business_id
  returning * into v_job;
  if v_job.id is null then
    raise exception 'Job not found for this business' using errcode = '22023';
  end if;
  return v_job;
end;
$$;

revoke all on function public.job_calendar_set_google_status(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.job_calendar_set_google_status(text, uuid, jsonb) to service_role;

-- Helps the per-staff conflict scans above; harmless if it already exists
-- in a different form (create index if not exists is a no-op then).
create index if not exists jobs_business_assigned_idx on public.jobs (business_id, assigned_to);
