-- TurnKey calendar was Google/iCal-sync-only for anything that wasn't a job:
-- calendar_events (schema-calendar-and-checklists.sql) only ever got written
-- by the backend's own sync jobs (service-role, no client insert policy at
-- all), and there was no table for availability blocks or working hours.
-- Result: opening Calendar and trying to create an "Event" or "Blocked
-- time" directly had nothing to save to. This adds exactly that, reusing
-- calendar_events for native events (rather than a second parallel table)
-- and adding the two tables genuinely missing.
-- Safe to re-run: idempotent.

-- ===== calendar_events: allow TurnKey-native events, not just synced ones =====
alter table public.calendar_events add column if not exists source text not null default 'external' check (source in ('external','turnkey'));
alter table public.calendar_events add column if not exists notes text;
alter table public.calendar_events add column if not exists created_by uuid;
-- connection_id was already nullable (external sync sets it; native events don't) — no change needed there.

drop policy if exists "create own business turnkey events" on public.calendar_events;
create policy "create own business turnkey events" on public.calendar_events
  for insert
  with check (business_id = public.current_business_id() and source = 'turnkey' and connection_id is null);
drop policy if exists "update own business turnkey events" on public.calendar_events;
create policy "update own business turnkey events" on public.calendar_events
  for update
  using (business_id = public.current_business_id() and source = 'turnkey')
  with check (business_id = public.current_business_id() and source = 'turnkey' and connection_id is null);
drop policy if exists "delete own business turnkey events" on public.calendar_events;
create policy "delete own business turnkey events" on public.calendar_events
  for delete
  using (business_id = public.current_business_id() and source = 'turnkey');

-- ===== Availability blocks: holiday/sick/training/etc — business-wide (user_id
-- null) or per-employee. Blocking is enforced client-side by the conflict
-- checker reading this table, same "warn, don't silently allow" pattern as
-- the rest of the scheduling flow. =====
create table if not exists public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid, -- null = whole business (e.g. "Business closed", public holiday)
  block_type text not null default 'unavailable' check (block_type in
    ('holiday','sick','personal','training','unavailable','business_closed','public_holiday','other')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default true,
  reason text,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.availability_blocks enable row level security;
drop policy if exists "read own business" on public.availability_blocks;
create policy "read own business" on public.availability_blocks
  for select
  using (business_id = public.current_business_id());
-- Owner/manager can block anyone or the whole business; a technician can only block their own time.
drop policy if exists "create availability block" on public.availability_blocks;
create policy "create availability block" on public.availability_blocks
  for insert
  with check (business_id = public.current_business_id() and (
    public.current_business_role() in ('owner','manager') or user_id = auth.uid()
  ));
drop policy if exists "update availability block" on public.availability_blocks;
create policy "update availability block" on public.availability_blocks
  for update
  using (business_id = public.current_business_id() and (
    public.current_business_role() in ('owner','manager') or user_id = auth.uid()
  ));
drop policy if exists "delete availability block" on public.availability_blocks;
create policy "delete availability block" on public.availability_blocks
  for delete
  using (business_id = public.current_business_id() and (
    public.current_business_role() in ('owner','manager') or user_id = auth.uid()
  ));
create index if not exists availability_blocks_business_time_idx on public.availability_blocks (business_id, start_at, end_at);

-- ===== Per-employee working hours (overrides business_hours below when present) =====
create table if not exists public.employee_working_hours (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday, matches JS Date#getDay()
  start_min int not null default 480,  -- 8:00am
  end_min int not null default 1020,   -- 5:00pm
  is_available boolean not null default true,
  unique (user_id, weekday)
);
alter table public.employee_working_hours enable row level security;
drop policy if exists "read own business" on public.employee_working_hours;
create policy "read own business" on public.employee_working_hours
  for select
  using (business_id = public.current_business_id());
drop policy if exists "owner or manager write" on public.employee_working_hours;
create policy "owner or manager write" on public.employee_working_hours
  for all
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));

-- ===== Business default working hours — what a new employee has no override yet falls back to =====
create table if not exists public.business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_min int not null default 480,
  end_min int not null default 1020,
  is_available boolean not null default true,
  unique (business_id, weekday)
);
alter table public.business_hours enable row level security;
drop policy if exists "read own business" on public.business_hours;
create policy "read own business" on public.business_hours
  for select
  using (business_id = public.current_business_id());
drop policy if exists "owner or manager write" on public.business_hours;
create policy "owner or manager write" on public.business_hours
  for all
  using (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'))
  with check (business_id = public.current_business_id() and public.current_business_role() in ('owner','manager'));
