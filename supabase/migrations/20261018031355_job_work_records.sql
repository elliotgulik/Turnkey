-- TurnKey — Job records / work hours / equipment maintenance.
-- Source for a NEW migration file; the parent process applies this via the
-- official Supabase CLI-generated migration. Apply only this migration;
-- do not apply unrelated pending migrations as part of this release.
-- Every statement is idempotent — safe to run against a database that
-- already has some or all of this (re-running creates nothing twice and
-- destroys no existing data).
--
-- Depends on (already in this repo, NOT recreated here):
--   public.businesses (id text primary key)        — schema-business-profile.sql
--   public.users      (id uuid, business_id text, role text check in
--                       ('owner','manager','technician'))
--                                                     — schema-app.sql / schema-team.sql
--   public.jobs       (id uuid, business_id text)   — supabase/migrations/20240101000000_...
--   public.attachments(id uuid, business_id text, customer_id uuid,
--                       job_id uuid, kind text, path text, filename text)
--                                                     — backend/supabase/schema-storage.sql
--                       kind already allows 'before_photo'/'after_photo'
--                       (backend/supabase/schema-customer-hub.sql) — not
--                       re-added here; the parent should confirm that
--                       migration is actually deployed before relying on it.
--
-- btree_gist is required for the EXCLUDE ... USING gist constraints below
-- (overlap-safe work logs / equipment usage, enforced by Postgres itself,
-- not by a check-then-insert race in application code). It is a standard,
-- commonly-already-enabled Supabase extension.
create extension if not exists btree_gist;

-- ===== equipment_assets: one row per physical piece of equipment that
-- accrues runtime hours and needs periodic servicing ================
create table if not exists public.equipment_assets (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  -- Hours between services, e.g. "change the pump oil every 200 hours".
  service_interval_hours numeric not null check (service_interval_hours > 0),
  -- Runtime hours already on this asset when it was first entered into
  -- TurnKey (a used machine isn't new at baseline_hours = 0).
  baseline_hours numeric not null default 0 check (baseline_hours >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.job_work_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists equipment_assets_set_updated_at on public.equipment_assets;
create trigger equipment_assets_set_updated_at
  before update on public.equipment_assets
  for each row execute function public.job_work_set_updated_at();

create index if not exists equipment_assets_business_idx on public.equipment_assets (business_id);

-- ===== job_work_logs: one row per worker's time entry against a job =====
create table if not exists public.job_work_logs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references public.businesses(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- Derived, not trusted from the client — always consistent with start/end.
  minutes integer generated always as (
    round(extract(epoch from (end_at - start_at)) / 60)::integer
  ) stored,
  notes text,
  -- Client-supplied UUID for the submission; one business+request_id pair
  -- can only ever create one log row, so a retried/duplicated submit is a
  -- no-op rather than a double entry.
  request_id uuid not null,
  equipment_request jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint job_work_logs_window_chk check (
    end_at > start_at and end_at - start_at <= interval '24 hours'
  )
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_work_logs_request_uidx') then
    alter table public.job_work_logs
      add constraint job_work_logs_request_uidx unique (business_id, request_id);
  end if;
end $$;

-- A worker can't be in two places (two overlapping job windows) at once —
-- enforced by Postgres itself so two concurrent submissions can't both land.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_work_logs_no_overlap') then
    alter table public.job_work_logs
      add constraint job_work_logs_no_overlap
      exclude using gist (
        business_id with =,
        user_id with =,
        tstzrange(start_at, end_at, '[)') with &&
      );
  end if;
end $$;

create index if not exists job_work_logs_business_job_idx on public.job_work_logs (business_id, job_id);
create index if not exists job_work_logs_business_user_start_idx on public.job_work_logs (business_id, user_id, start_at);

-- ===== equipment_usage: runtime hours entered per piece of equipment used
-- during a work log — NOT crew headcount x hours, one row per asset used =====
create table if not exists public.equipment_usage (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references public.businesses(id) on delete cascade,
  log_id uuid not null references public.job_work_logs(id) on delete cascade,
  asset_id uuid not null references public.equipment_assets(id) on delete cascade,
  hours numeric not null check (hours >= 0),
  notes text,
  -- Copied from the parent log at insert time (not independently editable)
  -- purely so the exclusion constraint below can reason about time ranges
  -- without a cross-table lookup.
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'equipment_usage_log_asset_uidx') then
    alter table public.equipment_usage
      add constraint equipment_usage_log_asset_uidx unique (log_id, asset_id);
  end if;
end $$;

-- One asset can't be run by two overlapping jobs at once.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'equipment_usage_no_overlap') then
    alter table public.equipment_usage
      add constraint equipment_usage_no_overlap
      exclude using gist (
        asset_id with =,
        tstzrange(start_at, end_at, '[)') with &&
      );
  end if;
end $$;

create index if not exists equipment_usage_business_asset_idx on public.equipment_usage (business_id, asset_id);

-- ===== equipment_service_events: immutable log of "this asset was
-- serviced" — never updated or deleted, never resets usage history =====
create table if not exists public.equipment_service_events (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references public.businesses(id) on delete cascade,
  asset_id uuid not null references public.equipment_assets(id) on delete cascade,
  -- The asset's total runtime hours AT the moment of servicing, computed
  -- server-side (see mark_equipment_serviced below) — never client-supplied.
  meter_hours numeric not null check (meter_hours >= 0),
  notes text,
  serviced_at timestamptz not null default now(),
  author uuid not null references public.users(id)
);

create index if not exists equipment_service_events_asset_idx on public.equipment_service_events (business_id, asset_id, serviced_at desc);

-- ===== RLS — these tables are only ever touched by the backend (service
-- role), never directly from the browser, unlike attachments/jobs/etc.
-- RLS is enabled anyway (defense in depth) and nothing is granted to
-- anon/authenticated, so even a future bug exposing the anon/authenticated
-- Postgres role can't read or write any of this. =====
alter table public.equipment_assets enable row level security;
alter table public.job_work_logs enable row level security;
alter table public.equipment_usage enable row level security;
alter table public.equipment_service_events enable row level security;

revoke all on public.equipment_assets from public, anon, authenticated;
revoke all on public.job_work_logs from public, anon, authenticated;
revoke all on public.equipment_usage from public, anon, authenticated;
revoke all on public.equipment_service_events from public, anon, authenticated;

grant all on public.equipment_assets to service_role;
grant all on public.job_work_logs to service_role;
grant all on public.equipment_usage to service_role;
grant all on public.equipment_service_events to service_role;

-- ===== record_job_work: the one write path for "submit a work log,
-- optionally with equipment runtime attached" — a single DB round trip so
-- the log + its equipment usage rows are atomic (no REST multi-write
-- transaction assumption), with explicit row locks (the referenced asset
-- rows, and this user's existing logs) in addition to the exclusion
-- constraints above, which are what actually make the overlap checks
-- race-safe under real concurrency. =====
create or replace function public.record_job_work(
  p_business_id text,
  p_job_id uuid,
  p_user_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_notes text,
  p_request_id uuid,
  p_equipment jsonb default '[]'::jsonb -- [{"asset_id":uuid,"hours":numeric,"notes":text}, ...]
) returns table(log_id uuid, deduped boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_log_id uuid;
  v_existing uuid;
  v_item jsonb;
  v_asset_id uuid;
  v_hours numeric;
begin
  if p_start_at is null or p_end_at is null or p_request_id is null then
    raise exception 'Work window and request id are required' using errcode = '22023';
  end if;
  if p_end_at <= p_start_at or p_end_at - p_start_at > interval '24 hours' then
    raise exception 'Invalid work window: end must be after start and within 24 hours' using errcode = '22023';
  end if;

  if not exists (select 1 from public.jobs where id = p_job_id and business_id = p_business_id) then
    raise exception 'Job not found for this business' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_user_id and business_id = p_business_id) then
    raise exception 'Staff member not found for this business' using errcode = '22023';
  end if;

  -- Serialize identical delivery keys, including submissions naming different workers.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id || ':' || p_request_id::text, 0));
  -- Idempotent retry: a prior successful call with this request id just
  -- returns the log it already created, rather than erroring or duplicating.
  select id into v_existing from public.job_work_logs
    where business_id = p_business_id and request_id = p_request_id;
  if v_existing is not null then
    if not exists(select 1 from public.job_work_logs where id=v_existing and job_id=p_job_id and user_id=p_user_id and start_at=p_start_at and end_at=p_end_at and notes is not distinct from p_notes and equipment_request=coalesce(p_equipment,'[]'::jsonb)) then
      raise exception 'Submission key already used for different work details' using errcode='22023';
    end if;
    return query select v_existing, true;
    return;
  end if;

  -- Serialize concurrent submissions for the same worker (the exclusion
  -- constraint is what ultimately rejects a genuine overlap; this lock just
  -- avoids both racing writers doing their equipment work in parallel).
  perform 1 from public.users where business_id = p_business_id and id = p_user_id for update;

  for v_item in select value from jsonb_array_elements(coalesce(p_equipment, '[]'::jsonb)) order by value->>'asset_id'
  loop
    v_asset_id := (v_item ->> 'asset_id')::uuid;
    if not exists (select 1 from public.equipment_assets where id = v_asset_id and business_id = p_business_id for update) then
      raise exception 'Equipment asset not found for this business' using errcode = '22023';
    end if;
  end loop;

  insert into public.job_work_logs (business_id, job_id, user_id, start_at, end_at, notes, request_id, equipment_request)
  values (p_business_id, p_job_id, p_user_id, p_start_at, p_end_at, p_notes, p_request_id, coalesce(p_equipment,'[]'::jsonb))
  returning id into v_log_id;

  for v_item in select value from jsonb_array_elements(coalesce(p_equipment, '[]'::jsonb)) order by value->>'asset_id'
  loop
    v_asset_id := (v_item ->> 'asset_id')::uuid;
    v_hours := (v_item ->> 'hours')::numeric;
    if v_hours is null or v_hours < 0 or v_hours > extract(epoch from (p_end_at-p_start_at))/3600 then
      raise exception 'Equipment runtime hours must be between zero and the work duration' using errcode = '22023';
    end if;
    insert into public.equipment_usage (business_id, log_id, asset_id, hours, notes, start_at, end_at)
    values (p_business_id, v_log_id, v_asset_id, v_hours, v_item ->> 'notes', p_start_at, p_end_at);
  end loop;

  return query select v_log_id, false;
end;
$$;

revoke all on function public.record_job_work(text, uuid, uuid, timestamptz, timestamptz, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_job_work(text, uuid, uuid, timestamptz, timestamptz, text, uuid, jsonb) to service_role;

-- ===== mark_equipment_serviced: the only way a service_event is created.
-- Locks the asset row so its computed meter_hours (current total runtime)
-- can't race against a concurrent record_job_work() call adding more usage
-- for the same asset — both lock the same equipment_assets row. =====
create or replace function public.mark_equipment_serviced(
  p_business_id text,
  p_asset_id uuid,
  p_author uuid,
  p_notes text
) returns public.equipment_service_events
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_asset_id uuid;
  v_baseline numeric;
  v_runtime numeric;
  v_event public.equipment_service_events;
begin
  select id, baseline_hours into v_asset_id, v_baseline
    from public.equipment_assets where id = p_asset_id and business_id = p_business_id for update;
  if v_asset_id is null then
    raise exception 'Equipment asset not found for this business' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_author and business_id = p_business_id and role in ('owner','manager')) then
    raise exception 'Author not found for this business' using errcode = '22023';
  end if;

  select v_baseline + coalesce(sum(hours), 0) into v_runtime
    from public.equipment_usage where asset_id = p_asset_id and business_id = p_business_id;

  insert into public.equipment_service_events (business_id, asset_id, meter_hours, notes, author)
  values (p_business_id, p_asset_id, v_runtime, p_notes, p_author)
  returning * into v_event;

  return v_event;
end;
$$;

revoke all on function public.mark_equipment_serviced(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_equipment_serviced(text, uuid, uuid, text) to service_role;

revoke all on function public.job_work_set_updated_at() from public, anon, authenticated;
grant execute on function public.job_work_set_updated_at() to service_role;

-- Support foreign-key checks and job/user lookups independently of tenant indexes.
create index if not exists job_work_logs_job_idx on public.job_work_logs(job_id);
create index if not exists job_work_logs_user_idx on public.job_work_logs(user_id);
create index if not exists equipment_service_events_author_idx on public.equipment_service_events(author);
create index if not exists equipment_service_events_asset_fk_idx on public.equipment_service_events(asset_id);
